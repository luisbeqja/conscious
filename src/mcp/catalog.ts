import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Effect } from "../capabilities/types.js";

export const DEFAULT_CATALOG_DIR = fileURLToPath(new URL("../../mcp/", import.meta.url));

const EFFECTS: readonly Effect[] = ["read", "draft", "commit"];
// A capability id: it prefixes every tool name the model sees.
const SERVER_NAME = /^[a-z][a-z0-9]{0,31}$/;

/**
 * One MCP server in the repo's `mcp/` catalog: its name, URL, auth and tools, plus
 * `enabled_by_default`, `default_effect` and `effects`. Being in the folder means it was reviewed in a
 * pull request.
 */
export interface McpServerEntry {
    name: string;
    description: string;
    url: string;
    auth: "none" | "oauth";
    enabledByDefault: boolean;
    /** Only these tools, when set. */
    include?: readonly string[];
    exclude: readonly string[];
    /** What a tool does when neither `effects` nor the server says it only reads. */
    defaultEffect: Effect;
    effects: ReadonlyMap<string, Effect>;
}

const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;

const effect = (value: unknown, where: string): Effect => {
    if (EFFECTS.includes(value as Effect)) return value as Effect;
    throw new Error(`${where} must be one of ${EFFECTS.join(", ")}`);
};

export const parseManifest = (text: string, folder: string): McpServerEntry => {
    const raw = record(parse(text));
    const where = `mcp/${folder}/manifest.yaml`;
    const name = raw.name;
    if (typeof name !== "string" || !SERVER_NAME.test(name) || name !== folder) {
        throw new Error(`${where}: name must match its folder and be lowercase letters and digits`);
    }
    const transport = record(raw.transport);
    const url = transport.url;
    if (transport.type !== "http" || typeof url !== "string" || !url.startsWith("https://")) {
        throw new Error(`${where}: only https transports are supported`);
    }
    const auth = record(raw.auth).type ?? "none";
    if (auth !== "none" && auth !== "oauth") throw new Error(`${where}: auth.type must be none or oauth`);
    const tools = record(raw.tools);
    return {
        name,
        description: typeof raw.description === "string" ? raw.description.trim() : name,
        url,
        auth,
        enabledByDefault: raw.enabled_by_default === true,
        include: strings(tools.default_enabled),
        exclude: strings(tools.default_excluded) ?? [],
        defaultEffect:
            raw.default_effect === undefined ? "commit" : effect(raw.default_effect, `${where} default_effect`),
        effects: new Map(
            Object.entries(record(raw.effects)).map(([tool, value]) => [
                tool,
                effect(value, `${where} effects.${tool}`),
            ]),
        ),
    };
};

export const readCatalog = (dir: string = DEFAULT_CATALOG_DIR): McpServerEntry[] => {
    let folders: string[];
    try {
        folders = readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
    } catch {
        return [];
    }
    return folders.map((folder) => parseManifest(readFileSync(join(dir, folder, "manifest.yaml"), "utf8"), folder));
};

/**
 * The servers this install connects to: `CONSCIOUS_MCP_SERVERS` names them (or says `none`), else
 * the catalog's defaults. Servers that need a sign-in wait for OAuth on the Vault page.
 */
export const selectServers = (catalog: readonly McpServerEntry[], setting: string | undefined): McpServerEntry[] => {
    const wanted = setting?.trim();
    if (wanted === "none") return [];
    if (!wanted) return catalog.filter((entry) => entry.enabledByDefault && entry.auth === "none");
    const names = wanted.split(",").map((name) => name.trim());
    const unknown = names.filter((name) => !catalog.some((entry) => entry.name === name));
    if (unknown.length) throw new Error(`CONSCIOUS_MCP_SERVERS names servers not in mcp/: ${unknown.join(", ")}`);
    const chosen = catalog.filter((entry) => names.includes(entry.name));
    const needSignIn = chosen.filter((entry) => entry.auth !== "none");
    if (needSignIn.length) {
        throw new Error(
            `Signing in to MCP servers is not built yet: ${needSignIn.map((entry) => entry.name).join(", ")}`,
        );
    }
    return chosen;
};
