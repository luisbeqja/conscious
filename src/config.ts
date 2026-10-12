export interface WhatsAppConfig {
    phoneNumberId: string;
    accessToken: string;
    verifyToken: string;
    appSecret: string;
}

export interface Config {
    port: number;
    timezone: string;
    model: { provider: string; id: string };
    whatsapp?: WhatsAppConfig;
    /** Conscious is personal: anyone not on this list is ignored. */
    allowedNumbers: ReadonlySet<string>;
    budgets: Budgets;
}

export interface Budgets {
    maxTurnsPerRun: number;
    maxToolCallsPerRun: number;
    /** Background agents running at once, per user. */
    maxBackgroundAgents: number;
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
};

const readWhatsApp = (env: NodeJS.ProcessEnv): WhatsAppConfig | undefined => {
    if (!env.WHATSAPP_PHONE_NUMBER_ID) return undefined;
    return {
        phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
        accessToken: required(env, "WHATSAPP_ACCESS_TOKEN"),
        verifyToken: required(env, "WHATSAPP_VERIFY_TOKEN"),
        appSecret: required(env, "WHATSAPP_APP_SECRET"),
    };
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => ({
    port: Number(env.PORT ?? 8100),
    timezone: env.CONSCIOUS_TIMEZONE ?? "Europe/Rome",
    model: {
        provider: env.CONSCIOUS_MODEL_PROVIDER ?? "anthropic",
        id: env.CONSCIOUS_MODEL ?? "claude-sonnet-5",
    },
    whatsapp: readWhatsApp(env),
    allowedNumbers: new Set(
        (env.CONSCIOUS_ALLOWED_NUMBERS ?? "")
            .split(",")
            .map((number) => number.trim().replace(/^\+/, ""))
            .filter(Boolean),
    ),
    budgets: { maxTurnsPerRun: 20, maxToolCallsPerRun: 40, maxBackgroundAgents: 3 },
});
