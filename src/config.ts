export interface Config {
    timezone: string;
    model: { provider: string; id: string };
    budgets: Budgets;
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
});

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
