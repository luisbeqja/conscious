export interface Config {
    timezone: string;
    model: { provider: string; id: string };
    budgets: Budgets;
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
