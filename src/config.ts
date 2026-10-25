import { join } from "node:path";
import type { E2BBrowserOptions } from "./browser/browser.js";
import type { ComposioConfig } from "./composio/client.js";
import type { ModelConfig } from "./engine/models.js";
import type { GoogleClient } from "./google/oauth.js";
import type { EmbeddingsConfig } from "./knowledge/embeddings.js";
import { type McpServerEntry, readCatalog, selectServers } from "./mcp/catalog.js";
import type { TranscriptionConfig } from "./media/transcribe.js";
import type { E2BOptions } from "./sandbox/e2b.js";
import { type PacingConfig, parseQuietHours } from "./scheduler/pacing.js";
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
    /** The model that picks emoji reactions, apart from the answers. Unset: nothing reacts. */
    reactions?: ModelConfig;
    budgets: Budgets;
    /** How often Conscious may write first. */
    pacing: PacingConfig;
    /** Unset means no computer: memory and the conversation live in this process only. */
    sandbox?: E2BOptions;
    /** A real browser per user, on an E2B desktop computer. Needs `sandbox` for the files it saves. */
    browser?: E2BBrowserOptions;
    /** MCP servers from the repo's catalog that this install connects to. */
    mcpServers: McpServerEntry[];
    /** Shopping through Shop MCP (shop.dev). Needs no key, so it is on unless turned off. */
    shop: boolean;
    /** Where web searches go. */
    search: SearchConfig;
    /** This install's Google OAuth client. Without it, the Google account is not offered. */
    google?: GoogleClient;
    /** This install's Spotify app. Without it, Spotify is not offered. */
    spotify?: SpotifyClient;
    /** Other apps through Composio, which holds each user's sign-ins. Off without a key. */
    composio?: ComposioConfig;
    /** Where voice notes are turned into text. Without it, Conscious says it cannot listen yet. */
    transcription?: TranscriptionConfig;
    /** Where text becomes vectors for search by meaning. Without it, searches match words only. */
    embeddings?: EmbeddingsConfig;
    /** The search index of official Italian pages (`pnpm italy:index`). No file, no capability. */
    italyIndex: string;
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

export interface TelegramConfig {
    /** From @BotFather. */
    botToken: string;
    /** Telegram user id → the user they are to Conscious. Conscious is personal: anyone else is ignored. */
    users: ReadonlyMap<string, string>;
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
        // Checked with the rest of Telegram's settings, so a bad bot token turns off only Telegram.
        if (name === "TELEGRAM_BOT_TOKEN") continue;
        const bad = [...value].findIndex((char) => char.charCodeAt(0) > 126);
        if (bad >= 0) {
            throw new Error(`${name} has a "${[...value][bad]}" at position ${bad + 1}; paste the full key again`);
        }
    }
};

// `||`, not `??`: a line left empty in a copied .env.example means "use the default".
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
    checkKeys(env);
    const dataDir = env.CONSCIOUS_DATA_DIR || join(process.cwd(), ".conscious");
    const model: ModelConfig = {
        provider: env.CONSCIOUS_MODEL_PROVIDER || "anthropic",
        id: env.CONSCIOUS_MODEL || "claude-sonnet-5",
        baseUrl: env.CONSCIOUS_MODEL_BASE_URL || undefined,
        apiKey: env.CONSCIOUS_MODEL_API_KEY || undefined,
    };
    return {
        timezone: env.CONSCIOUS_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
        pluginsDir: env.CONSCIOUS_PLUGINS_DIR || join(process.cwd(), "plugins"),
        dataDir,
        vault: loadVaultConfig(env),
        model,
        // Same provider; a smaller model of it is quicker, and "none" turns reactions off.
        reactions:
            env.CONSCIOUS_REACTIONS_MODEL === "none"
                ? undefined
                : { ...model, id: env.CONSCIOUS_REACTIONS_MODEL || model.id },
        budgets: { maxTurnsPerRun: 20, maxToolCallsPerRun: 40, maxBackgroundAgents: 3 },
        pacing: {
            quietHours: parseQuietHours(env.CONSCIOUS_QUIET_HOURS || "22-8"),
            maxUnpromptedPerDay: Number(env.CONSCIOUS_MAX_UNPROMPTED || 3),
        },
        sandbox: loadSandboxConfig(env),
        browser: loadBrowserConfig(env),
        mcpServers: selectServers(readCatalog(), env.CONSCIOUS_MCP_SERVERS),
        shop: env.CONSCIOUS_SHOP !== "false",
        search: loadSearchConfig(env),
        google:
            env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
                ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
                : undefined,
        spotify:
            env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET
                ? { clientId: env.SPOTIFY_CLIENT_ID, clientSecret: env.SPOTIFY_CLIENT_SECRET }
                : undefined,
        composio: env.COMPOSIO_API_KEY
            ? {
                  apiKey: env.COMPOSIO_API_KEY,
                  baseUrl: env.COMPOSIO_BASE_URL || undefined,
                  authConfigs: parsePairs(env.COMPOSIO_AUTH_CONFIGS),
                  apps:
                      env.COMPOSIO_APPS === "all"
                          ? "all"
                          : env.COMPOSIO_APPS
                            ? list(env.COMPOSIO_APPS).map((app) => app.toLowerCase())
                            : undefined,
              }
            : undefined,
        transcription: loadTranscriptionConfig(env),
        embeddings: loadEmbeddingsConfig(env),
        italyIndex: env.CONSCIOUS_ITALY_INDEX || join(dataDir, "italy", "index.sqlite"),
    };
};

/** `a=1,b=2` → `{ a: "1", b: "2" }`; empty or unset → undefined. */
const parsePairs = (value: string | undefined): Record<string, string> | undefined => {
    const pairs = (value ?? "")
        .split(",")
        .map((pair) => pair.split("=").map((part) => part.trim()))
        .filter((pair): pair is [string, string] => pair.length === 2 && Boolean(pair[0]) && Boolean(pair[1]));
    return pairs.length ? Object.fromEntries(pairs.map(([key, id]) => [key.toLowerCase(), id])) : undefined;
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

/** Mistral when there is a Mistral key, else OpenAI, else a local OpenAI-style server (Ollama) if one is set. */
const loadEmbeddingsConfig = (env: NodeJS.ProcessEnv): EmbeddingsConfig | undefined => {
    const provider =
        env.CONSCIOUS_EMBEDDINGS ||
        (env.MISTRAL_API_KEY
            ? "mistral"
            : env.OPENAI_API_KEY
              ? "openai"
              : env.CONSCIOUS_EMBEDDINGS_URL
                ? "local"
                : "none");
    const model = env.CONSCIOUS_EMBEDDINGS_MODEL || undefined;
    if (provider === "none") return undefined;
    if (provider === "mistral") {
        return {
            provider,
            baseUrl: "https://api.mistral.ai/v1",
            model: model ?? "mistral-embed",
            apiKey: required(env, "MISTRAL_API_KEY"),
        };
    }
    if (provider === "openai") {
        return {
            provider,
            baseUrl: "https://api.openai.com/v1",
            model: model ?? "text-embedding-3-small",
            apiKey: required(env, "OPENAI_API_KEY"),
        };
    }
    if (provider === "local") {
        return { provider, baseUrl: required(env, "CONSCIOUS_EMBEDDINGS_URL"), model: model ?? "bge-m3" };
    }
    throw new Error(`CONSCIOUS_EMBEDDINGS must be "mistral", "openai", "local" or "none", not "${provider}"`);
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

const loadBrowserConfig = (env: NodeJS.ProcessEnv): E2BBrowserOptions | undefined => {
    const backend = env.CONSCIOUS_BROWSER || "none";
    if (backend === "none") return undefined;
    if (backend !== "e2b") throw new Error(`CONSCIOUS_BROWSER must be "e2b" or "none", not "${backend}"`);
    // Screenshots and saved files land on the user's computer.
    if ((env.CONSCIOUS_SANDBOX || "none") !== "e2b")
        throw new Error("CONSCIOUS_BROWSER=e2b needs CONSCIOUS_SANDBOX=e2b");
    return {
        apiKey: required(env, "E2B_API_KEY"),
        domain: env.E2B_DOMAIN || undefined,
        proxy: env.HTTPS_PROXY || env.https_proxy || undefined,
        template: env.CONSCIOUS_BROWSER_TEMPLATE || "desktop",
        idleMs: Number(env.CONSCIOUS_BROWSER_IDLE_MINUTES || 5) * 60_000,
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

/**
 * The Telegram bot, when this install has one. Each Telegram user id listed is a user of their own
 * (`telegram:<id>`), or, written `<id>=<user>`, that user: the same person as on WhatsApp or the app.
 * The list may start empty: a sender who is not on it is logged with their id.
 */
export const loadTelegramConfig = (env: NodeJS.ProcessEnv = process.env): TelegramConfig | undefined => {
    const botToken = env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return undefined;
    if (!/^\d+:[\w-]+$/.test(botToken))
        throw new Error("TELEGRAM_BOT_TOKEN should look like 123456789:AAH…, as @BotFather gives it");
    const users = new Map<string, string>();
    for (const entry of list(env.CONSCIOUS_TELEGRAM_USERS)) {
        const [telegramId = "", userId] = entry.split("=").map((part) => part.trim());
        // A username can change hands; the numeric id is the person.
        if (!/^\d+$/.test(telegramId)) {
            throw new Error(`CONSCIOUS_TELEGRAM_USERS takes numeric Telegram user ids, not "${telegramId}"`);
        }
        users.set(telegramId, userId || `telegram:${telegramId}`);
    }
    return { botToken, users };
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
