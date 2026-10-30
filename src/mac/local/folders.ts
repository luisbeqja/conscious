import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { MacFolder } from "../protocol.js";

/** `~/x` is x in the home folder. */
export const expandHome = (path: string): string =>
    path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

/** The allowed folders as the chat sees them. */
export const listFolders = (folders: readonly string[]): MacFolder[] =>
    folders.map((path) => ({ name: basename(path), path }));

const inside = (folder: string, path: string): boolean => {
    const rest = relative(folder, path);
    return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};

/** The real path of a folder that exists, or undefined. */
export const realFolder = (path: string): string | undefined => {
    try {
        const real = realpathSync(expandHome(path));
        return statSync(real).isDirectory() ? real : undefined;
    } catch {
        return undefined;
    }
};

/**
 * The folder a request names: an allowed folder by its name, or a path inside one. Undefined for
 * anything else, a link that leads outside included, since the path is resolved first.
 */
export const resolveFolder = (asked: string, allowed: readonly string[]): string | undefined => {
    const name = asked.trim();
    const byName = allowed.filter((folder) => basename(folder) === name);
    if (byName.length === 1) return byName[0];
    if (!isAbsolute(expandHome(name))) return undefined;
    const real = realFolder(name);
    return real && allowed.some((folder) => inside(folder, real)) ? real : undefined;
};
