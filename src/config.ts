import type { E2BOptions } from "./sandbox/e2b.js";

export interface Config {
    timezone: string;
    model: { provider: string; id: string };
    budgets: Budgets;
    /** Unset means no computer: memory and the conversation live in this process only. */
    sandbox?: E2BOptions;
}

export type PhotonPlatform = "imessage" | "whatsapp";

export interface PhotonConfig {
    projectId: string;
    projectSecret: string;
    platforms: readonly PhotonPlatform[];
    /** Conscious is personal: senders not on this list are ignored. */
    allowedUsers: ReadonlySet<string>;
}

export interface Budgets {
    maxTurnsPerRun: number;
    maxToolCallsPerRun: number;
    /** Background agents running at once, per user. */
    maxBackgroundAgents: number;
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => ({
    timezone: env.CONSCIOUS_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    model: {
        provider: env.CONSCIOUS_MODEL_PROVIDER ?? "anthropic",
        id: env.CONSCIOUS_MODEL ?? "claude-sonnet-5",
    },
    budgets: { maxTurnsPerRun: 20, maxToolCallsPerRun: 40, maxBackgroundAgents: 3 },
    sandbox: loadSandboxConfig(env),
});

const loadSandboxConfig = (env: NodeJS.ProcessEnv): E2BOptions | undefined => {
    const backend = env.CONSCIOUS_SANDBOX ?? "none";
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
    const platforms = list(env.PHOTON_PLATFORMS ?? "imessage,whatsapp");
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
