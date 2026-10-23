import { join } from "node:path";
import type { ModelConfig } from "./engine/models.js";
import type { GoogleClient } from "./google/oauth.js";
import { type McpServerEntry, readCatalog, selectServers } from "./mcp/catalog.js";
import type { TranscriptionConfig } from "./media/transcribe.js";
import type { E2BOptions } from "./sandbox/e2b.js";
import type { SpotifyClient } from "./spotify/oauth.js";
import type { SearchConfig } from "./web/search.js";

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
    /** Where web searches go. */
    search: SearchConfig;
    /** This install's Google OAuth client. Without it, the Google account is not offered. */
    google?: GoogleClient;
    /** This install's Spotify app. Without it, Spotify is not offered. */
    spotify?: SpotifyClient;
    /** Where voice notes are turned into text. Without it, Conscious says it cannot listen yet. */
    transcription?: TranscriptionConfig;
}

export type PhotonPlatform = "imessage" | "whatsapp";

export interface PhotonConfig {
    projectId: string;
    projectSecret: string;
    platforms: readonly PhotonPlatform[];
    /** Conscious is personal: senders not on this list are ignored. */
    allowedUsers: ReadonlySet<string>;
    /** The approved template that carries messages outside WhatsApp's 24-hour window. */
    whatsappTemplate?: { name: string; languageCode: string };
}

export interface AppConfig {
    port: number;
    /** Who can use the phone app. Each gets an access code the first time they are listed. */
    users: readonly string[];
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

/**
 * Keys go into HTTP headers, which take no characters past Latin-1. A key copied from a
 * page that masks it (sk-ant-u•••) otherwise fails only on the first message, as a vague error.
 */
const checkKeys = (env: NodeJS.ProcessEnv): void => {
    for (const [name, value] of Object.entries(env)) {
        if (!/(_KEY|_SECRET|_TOKEN)$/.test(name) || !value) continue;
        const bad = [...value].findIndex((char) => char.charCodeAt(0) > 126);
        if (bad >= 0) {
            throw new Error(`${name} has a "${[...value][bad]}" at position ${bad + 1}; paste the full key again`);
        }
    }
};

// `||`, not `??`: a line left empty in a copied .env.example means "use the default".
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
    checkKeys(env);
    return {
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
        search: loadSearchConfig(env),
        google:
            env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
                ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
                : undefined,
        spotify:
            env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET
                ? { clientId: env.SPOTIFY_CLIENT_ID, clientSecret: env.SPOTIFY_CLIENT_SECRET }
                : undefined,
        transcription: loadTranscriptionConfig(env),
    };
};

/** Mistral's Voxtral when there is a Mistral key, else OpenAI's, else a local Whisper server if one is set. */
const loadTranscriptionConfig = (env: NodeJS.ProcessEnv): TranscriptionConfig | undefined => {
    const provider =
        env.CONSCIOUS_TRANSCRIBE ||
        (env.MISTRAL_API_KEY
            ? "mistral"
            : env.OPENAI_API_KEY
              ? "openai"
              : env.CONSCIOUS_TRANSCRIBE_URL
                ? "local"
                : "none");
    const model = env.CONSCIOUS_TRANSCRIBE_MODEL || undefined;
    if (provider === "none") return undefined;
    if (provider === "mistral") {
        return {
            provider,
            baseUrl: "https://api.mistral.ai/v1",
            model: model ?? "voxtral-mini-latest",
            apiKey: required(env, "MISTRAL_API_KEY"),
        };
    }
    if (provider === "openai") {
        return {
            provider,
            baseUrl: "https://api.openai.com/v1",
            model: model ?? "gpt-4o-mini-transcribe",
            apiKey: required(env, "OPENAI_API_KEY"),
        };
    }
    if (provider === "local") {
        return { provider, baseUrl: required(env, "CONSCIOUS_TRANSCRIBE_URL"), model: model ?? "whisper-1" };
    }
    throw new Error(`CONSCIOUS_TRANSCRIBE must be "mistral", "openai", "local" or "none", not "${provider}"`);
};

/** A Brave key or a SearXNG address picks that engine; with neither, DuckDuckGo needs no setup. */
const loadSearchConfig = (env: NodeJS.ProcessEnv): SearchConfig => {
    const provider =
        env.CONSCIOUS_SEARCH || (env.BRAVE_API_KEY ? "brave" : env.CONSCIOUS_SEARXNG_URL ? "searxng" : "duckduckgo");
    if (provider === "brave") return { provider, apiKey: required(env, "BRAVE_API_KEY") };
    if (provider === "searxng") return { provider, url: required(env, "CONSCIOUS_SEARXNG_URL") };
    if (provider === "duckduckgo") return { provider };
    throw new Error(`CONSCIOUS_SEARCH must be "duckduckgo", "brave" or "searxng", not "${provider}"`);
};

const loadSandboxConfig = (env: NodeJS.ProcessEnv): E2BOptions | undefined => {
    const backend = env.CONSCIOUS_SANDBOX || "none";
    if (backend === "none") return undefined;
    if (backend !== "e2b") throw new Error(`CONSCIOUS_SANDBOX must be "e2b" or "none", not "${backend}"`);
    return {
        apiKey: required(env, "E2B_API_KEY"),
        domain: env.E2B_DOMAIN || undefined,
        // E2B's SDK ignores HTTPS_PROXY on its own.
        proxy: env.HTTPS_PROXY || env.https_proxy || undefined,
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

/** The phone app's server. `fallbackUser` is who uses it when no users are listed; undefined leaves it off. */
export const loadAppConfig = (env: NodeJS.ProcessEnv = process.env, fallbackUser?: string): AppConfig | undefined => {
    const users = list(env.CONSCIOUS_APP_USERS);
    if (!users.length && !fallbackUser) return undefined;
    return { port: Number(env.CONSCIOUS_APP_PORT || 8788), users: users.length ? users : [fallbackUser as string] };
};

const PLATFORMS: readonly PhotonPlatform[] = ["imessage", "whatsapp"];

const list = (value: string | undefined): string[] =>
    (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

const required = (env: NodeJS.ProcessEnv, name: string, alias?: string): string => {
    const value = env[name] || (alias ? env[alias] : undefined);
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
        // Photon's dashboard hands out the SPECTRUM_ names, so both are read.
        projectId: required(env, "PHOTON_PROJECT_ID", "SPECTRUM_PROJECT_ID"),
        projectSecret: required(env, "PHOTON_PROJECT_SECRET", "SPECTRUM_PROJECT_SECRET"),
        platforms: platforms as PhotonPlatform[],
        allowedUsers,
        whatsappTemplate: env.CONSCIOUS_WHATSAPP_TEMPLATE
            ? {
                  name: env.CONSCIOUS_WHATSAPP_TEMPLATE,
                  languageCode: env.CONSCIOUS_WHATSAPP_TEMPLATE_LANGUAGE || "en",
              }
            : undefined,
    };
};
