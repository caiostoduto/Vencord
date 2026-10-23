/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { spawn } from "child_process";
import { app, autoUpdater } from "electron";
import EventEmitter from "events";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync } from "original-fs";
import { basename, dirname, join } from "path";

import { DATA_DIR } from "./utils/constants";

function isNewer($new: string, old: string) {
    const newParts = $new.slice(4).split(".").map(Number);
    const oldParts = old.slice(4).split(".").map(Number);

    for (let i = 0; i < oldParts.length; i++) {
        if (newParts[i] > oldParts[i]) return true;
        if (newParts[i] < oldParts[i]) return false;
    }
    return false;
}

function patchLatest() {
    if (process.env.DISABLE_UPDATER_AUTO_PATCHING) return;

    try {
        const currentAppPath = dirname(process.execPath);
        const currentVersion = basename(currentAppPath);
        const discordPath = join(currentAppPath, "..");

        const latestVersion = readdirSync(discordPath).reduce((prev, curr) => {
            return (curr.startsWith("app-") && isNewer(curr, prev))
                ? curr
                : prev;
        }, currentVersion as string);

        if (latestVersion === currentVersion) return;

        const oldResources = join(discordPath, currentVersion, "resources");
        const oldVencordAsar = join(oldResources, "app.asar");

        const resources = join(discordPath, latestVersion, "resources");
        const newAppAsar = join(resources, "app.asar");
        const newAppAsarBackup = join(resources, "_app.asar");

        if (!existsSync(oldVencordAsar) || !existsSync(newAppAsar) || existsSync(newAppAsarBackup)) return;

        console.info(`[Vencord] Detected Host Update (${currentVersion} -> ${latestVersion}). Repatching...`);

        renameSync(newAppAsar, newAppAsarBackup);
        copyFileSync(oldVencordAsar, newAppAsar);
    } catch (err) {
        console.error("[Vencord] Failed to repatch latest host update", err);
    }
}

/**
 * macOS
 *
 * On Windows and Linux Discord installs every host version into its own sibling folder (app-1.0.x), so the
 * old, still running (patched) process can simply patch the new folder.
 *
 * macOS has a single bundle (Discord.app) that gets updated in place or swapped out entirely, and - for
 * updaters that apply the update after the app has quit - the swap can happen after our process is already gone.
 * So instead of patching from inside the process, we hand the job to a tiny detached /bin/sh watcher that
 * outlives Discord, waits for the stock app.asar to show up, and re-applies the loader (the file we are running from).
 *
 * The watcher never acts unless app.asar is no longer our loader, and it never touches a file that
 * already looks like a Vencord loader, so it cannot clobber a fresh install or loop.
 */
const MAC_WATCHER = String.raw`
RES="$1"; STUB="$2"; LOG="$3"; PARENT="$4"
APP="$RES/app.asar"; ORIG="$RES/_app.asar"; MACOS="$(dirname "$RES")/MacOS"
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
sig() { stat -f '%z:%m:%i' "$1" 2>/dev/null || echo missing; }
size() { stat -f '%z' "$1" 2>/dev/null || echo 0; }
# asar starts with a 4-byte "4" followed by the header size, which must fit inside the file (rejects truncated copies)
valid_asar() { set -- $(od -An -tu4 -N8 "$APP" 2>/dev/null); [ "$1" = 4 ] && [ $(($2 + 8)) -le "$(size "$APP")" ]; }
is_loader() { [ -f "$APP" ] && cmp -s "$APP" "$STUB"; }
# something else that looks like a Vencord loader (e.g. a fresh install): never touch it
looks_like_vencord() { [ -f "$APP" ] && [ "$(size "$APP")" -lt 65536 ] && grep -aq 'patcher\.js' "$APP"; }

patch() {
    NEW="$RES/.app.asar.vencord-new"; OLD="$RES/_app.asar.vencord-old"
    cp -f "$STUB" "$NEW" || { log "could not write loader into $RES"; return 1; }
    [ -e "$ORIG" ] && mv -f "$ORIG" "$OLD"
    if mv -f "$APP" "$ORIG" && mv -f "$NEW" "$APP"; then
        rm -f "$OLD"; log "repatched $RES"
        if pgrep -f "$MACOS/" >/dev/null 2>&1; then
            osascript -e 'display notification "Vencord was restored after a Discord update. Restart Discord to load it." with title "Vencord"' >/dev/null 2>&1
        fi
        return 0
    fi
    log "patching failed, rolling back"
    [ -e "$ORIG" ] && [ ! -e "$APP" ] && mv -f "$ORIG" "$APP"
    [ -e "$OLD" ] && [ ! -e "$ORIG" ] && mv -f "$OLD" "$ORIG"
    rm -f "$NEW"; return 1
}

# 1. Updaters that install on quit do their work after Discord has exited
i=0; while kill -0 "$PARENT" 2>/dev/null && [ "$i" -lt 120 ]; do sleep 1; i=$((i+1)); done

# 2. Wait for the host files to be replaced (extend the window while an installer helper is alive)
t=0; limit=180
while [ "$t" -lt "$limit" ]; do
    if [ -f "$APP" ] && ! is_loader; then
        if looks_like_vencord; then log "app.asar is another Vencord loader, leaving it alone"; exit 0; fi
        a="$(sig "$APP")"; sleep 1; b="$(sig "$APP")"; sleep 1; c="$(sig "$APP")"
        if [ "$a" = "$b" ] && [ "$b" = "$c" ] && [ "$(size "$APP")" -ge 65536 ] && valid_asar; then patch; exit $?; fi
    fi
    if [ "$limit" -lt 600 ] && pgrep -f 'ShipIt|Squirrel' >/dev/null 2>&1; then limit=600; fi
    sleep 1; t=$((t+1))
done
log "no host update detected"
`;

function setupMacOS() {
    if (process.env.DISABLE_UPDATER_AUTO_PATCHING) return;

    const logFile = join(DATA_DIR, "persist-macos.log");
    const log = (msg: string) => {
        try {
            mkdirSync(DATA_DIR, { recursive: true });
            appendFileSync(logFile, `${new Date().toISOString()} [host] ${msg}\n`);
        } catch { /* logging must never break startup */ }
    };

    // Written on every launch so it is obvious whether this code is loaded and whether the layout is what we expect
    log(`armed: resources=${process.resourcesPath} app.asar=${existsSync(join(process.resourcesPath, "app.asar"))} _app.asar=${existsSync(join(process.resourcesPath, "_app.asar"))}`);

    let scheduled = false;
    const schedule = (reason: string) => {
        if (scheduled) return;

        try {
            const resources = process.resourcesPath;
            const appAsar = join(resources, "app.asar");
            const backup = join(resources, "_app.asar");

            // We must be running from a loader installed as app.asar, with Discord's original next to it
            if (!existsSync(appAsar) || !existsSync(backup)) {
                log(`not scheduling (${reason}): unexpected layout in ${resources}`);
                return;
            }

            mkdirSync(DATA_DIR, { recursive: true });
            // Snapshot of the loader that is currently working
            const stub = join(DATA_DIR, "host-loader.asar");
            copyFileSync(appAsar, stub);

            scheduled = true;
            log(`scheduling repatch watcher (${reason}) for ${resources}`);

            spawn("/bin/sh", ["-c", MAC_WATCHER, "vencord-repatch", resources, stub, logFile, String(process.pid)], {
                detached: true,
                stdio: "ignore"
            }).unref();
        } catch (err) {
            console.error("[Vencord] Failed to schedule macOS repatch", err);
        }
    };

    // Same hook the Windows/Linux implementation uses
    EventEmitter.prototype.emit = new Proxy(EventEmitter.prototype.emit, {
        apply(target, thisArg, argArray) {
            if (argArray[0] === "host-updated") schedule("host-updated");
            return Reflect.apply(target, thisArg, argArray);
        },
    });

    // Squirrel.Mac (electron autoUpdater) events, in case the updater in use goes through it
    try {
        const squirrel = autoUpdater as EventEmitter;
        squirrel.on("update-downloaded", () => schedule("autoUpdater update-downloaded"));
        squirrel.on("before-quit-for-update", () => schedule("autoUpdater before-quit-for-update"));
    } catch { /* autoUpdater is unavailable in some Electron builds */ }

    // Any quit may be an update restart; the watcher is a no-op and exits after a few minutes if nothing changed
    app.on("before-quit", () => schedule("before-quit"));
    app.on("will-quit", () => schedule("will-quit"));
    process.once("exit", () => schedule("exit"));
}

if (process.platform === "darwin") {
    setupMacOS();
} else if (process.platform === "win32" || process.platform === "linux") {
    EventEmitter.prototype.emit = new Proxy(EventEmitter.prototype.emit, {
        apply(target, thisArg, argArray) {
            if (argArray[0] === "host-updated") {
                patchLatest();
            }

            return Reflect.apply(target, thisArg, argArray);
        },
    });

    // Try to patch latest on before-quit
    // Discord's Win32 updater will call app.quit() on restart and open new version on will-quit
    app.on("before-quit", patchLatest);
}
