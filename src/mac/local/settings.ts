import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** What this Mac keeps: where Conscious is, the token that proves it is the user's Mac, and what Claude Code may touch. */
export interface MacSettings {
    /** The Conscious install, e.g. https://conscious.example.com. */
    server: string;
    /** Given once when pairing. It lives in this file only, readable by this user alone. */
    token: string;
    /** How the Mac is called in the chat. */
    name: string;
    /** Real paths of the folders Claude Code may work in. Nothing outside them. */
    folders: string[];
    /** The Claude Code program. Found when pairing: a shell alias is invisible to launchd. */
    claude: string;
    /**
     * acceptEdits: Claude Code edits files in the folder, runs what its own settings allow, and is
     * refused anything else, since nobody is at the Mac to approve it.
     */
    permissionMode: string;
    /** A Claude model for these jobs, like sonnet. Unset: Claude Code's own default. */
    model?: string;
}

export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];

export const settingsFile = (env: NodeJS.ProcessEnv = process.env): string =>
    env.CONSCIOUS_MAC_SETTINGS || join(homedir(), ".config", "conscious", "mac.json");

export const readSettings = (file: string): MacSettings | undefined =>
    existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as MacSettings) : undefined;

export const writeSettings = (file: string, settings: MacSettings): void => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
};
