import { join } from "node:path";
import type { ModelConfig } from "./engine/models.js";
import { type McpServerEntry, readCatalog, selectServers } from "./mcp/catalog.js";
import type { E2BOptions } from "./sandbox/e2b.js";

export interface Config {
    timezone: string;
    /** The bundled plugins: one folder per plugin. */
    pluginsDir: string;
    /** Where Conscious keeps what must survive a restart: the Vault, plugins, installs. */
    dataDir: string;
    vault: VaultConfig;
    model: ModelConfig;
    budgets: Budgets;
    /** Unset means no computer: memory and the conversation live in this process only. */
    sandbox?: E2BOptions;
    /** MCP servers from the repo's catalog that this install connects to. */
    mcpServers: McpServerEntry[];
}

export type PhotonPlatform = "imessage" | "whatsapp";

export interface PhotonConfig {
    projectId: string;
    projectSecret: string;
    platforms: readonly PhotonPlatform[];
    /** Conscious is personal: senders not on this list are ignored. */
    allowedUsers: ReadonlySet<string>;
}

export interface VaultConfig {
    port: number;
    /** What the user's phone opens. Behind a tunnel or proxy in production, so it is https. */
    publicUrl: string;
    /** 32 bytes, base64. Without it, a key is created once in the data folder. */
    key?: Buffer;
}

export interface Budgets {
    maxTurnsPerRun: number;
    maxToolCallsPerRun: number;
    /** Background agents running at once, per user. */
    maxBackgroundAgents: number;
}

// `||`, not `??`: a line left empty in a copied .env.example means "use the default".
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => ({
    timezone: env.CONSCIOUS_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
    pluginsDir: env.CONSCIOUS_PLUGINS_DIR || join(process.cwd(), "plugins"),
    dataDir: env.CONSCIOUS_DATA_DIR || join(process.cwd(), ".conscious"),
    vault: loadVaultConfig(env),
    model: {
        provider: env.CONSCIOUS_MODEL_PROVIDER || "anthropic",
        id: env.CONSCIOUS_MODEL || "claude-sonnet-5",
        baseUrl: env.CONSCIOUS_MODEL_BASE_URL || undefined,
        apiKey: env.CONSCIOUS_MODEL_API_KEY || undefined,
    },
    budgets: { maxTurnsPerRun: 20, maxToolCallsPerRun: 40, maxBackgroundAgents: 3 },
    sandbox: loadSandboxConfig(env),
    mcpServers: selectServers(readCatalog(), env.CONSCIOUS_MCP_SERVERS),
});

const loadSandboxConfig = (env: NodeJS.ProcessEnv): E2BOptions | undefined => {
    const backend = env.CONSCIOUS_SANDBOX || "none";
    if (backend === "none") return undefined;
    if (backend !== "e2b") throw new Error(`CONSCIOUS_SANDBOX must be "e2b" or "none", not "${backend}"`);
    return {
        apiKey: required(env, "E2B_API_KEY"),
        domain: env.E2B_DOMAIN || undefined,
        template: env.CONSCIOUS_SANDBOX_TEMPLATE || "base",
        idleMs: Number(env.CONSCIOUS_SANDBOX_IDLE_MINUTES || 10) * 60_000,
        internet: env.CONSCIOUS_SANDBOX_INTERNET === "true",
    };
};

const loadVaultConfig = (env: NodeJS.ProcessEnv): VaultConfig => {
    const port = Number(env.CONSCIOUS_VAULT_PORT || 8787);
    return {
        port,
        publicUrl: env.CONSCIOUS_PUBLIC_URL || `http://localhost:${port}`,
        key: env.CONSCIOUS_VAULT_KEY ? Buffer.from(env.CONSCIOUS_VAULT_KEY, "base64") : undefined,
    };
};

const PLATFORMS: readonly PhotonPlatform[] = ["imessage", "whatsapp"];

const list = (value: string | undefined): string[] =>
    (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

const required = (env: NodeJS.ProcessEnv, name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set (see .env.example)`);
    return value;
};

export const loadPhotonConfig = (env: NodeJS.ProcessEnv = process.env): PhotonConfig => {
    const platforms = list(env.PHOTON_PLATFORMS || "imessage,whatsapp");
    const unknown = platforms.filter((platform) => !PLATFORMS.includes(platform as PhotonPlatform));
    if (unknown.length) throw new Error(`PHOTON_PLATFORMS has unknown platforms: ${unknown.join(", ")}`);
    const allowedUsers = new Set(list(env.CONSCIOUS_ALLOWED_USERS));
    if (allowedUsers.size === 0) throw new Error("CONSCIOUS_ALLOWED_USERS is empty, so nobody could talk to Conscious");
    return {
        projectId: required(env, "PHOTON_PROJECT_ID"),
        projectSecret: required(env, "PHOTON_PROJECT_SECRET"),
        platforms: platforms as PhotonPlatform[],
        allowedUsers,
    };
};
