import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Install, PluginInstalls, PluginRegistry, SavedVersion } from "./registry.js";

interface SavedPlugins {
    versions: SavedVersion[];
    installs: Record<string, Install[]>;
}

/**
 * Keeps the plugins and every user's installs in one JSON file, so plugins the agent wrote and
 * disabled versions survive a restart. Saved after every change.
 */
export const persistPlugins = (file: string, registry: PluginRegistry, installs: PluginInstalls): void => {
    if (existsSync(file)) {
        const saved = JSON.parse(readFileSync(file, "utf8")) as SavedPlugins;
        registry.restore(saved.versions);
        installs.restore(saved.installs);
    }
    const save = () => {
        const state: SavedPlugins = { versions: registry.snapshot(), installs: installs.snapshot() };
        mkdirSync(dirname(file), { recursive: true });
        const temporary = `${file}.tmp`;
        writeFileSync(temporary, JSON.stringify(state));
        renameSync(temporary, file);
    };
    registry.onChange = save;
    installs.onChange = save;
};
