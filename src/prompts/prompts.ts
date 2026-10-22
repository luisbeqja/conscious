import type { BackgroundTask } from "../agents/background-agents.js";
import { promptFile } from "./prompt-file.js";

const SYSTEM = promptFile(import.meta.url, "system.md");
const BACKGROUND = promptFile(import.meta.url, "background.md");
const SKILLS = promptFile(import.meta.url, "skills.md");

/** What the user's computer holds for the prompt. Absent when they have no computer. */
export interface ComputerContext {
    /** The memory index. */
    memory: string;
    /** The skills list. */
    skills: string;
}

const fill = (template: string, capabilities: string, computer?: ComputerContext): string => {
    const prompt = template.replace("{{capabilities}}", capabilities);
    if (!computer) return prompt;
    return [
        prompt,
        SKILLS.replace("{{skills}}", computer.skills),
        `# What you remember about the user\n\n${computer.memory}`,
    ].join("\n\n");
};

export const buildSystemPrompt = (capabilities: string, computer?: ComputerContext): string =>
    fill(SYSTEM, capabilities, computer);

export const buildBackgroundPrompt = (capabilities: string, computer?: ComputerContext): string =>
    fill(BACKGROUND, capabilities, computer);

const formatNow = (now: Date, timezone: string): string =>
    `${new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "short", timeZone: timezone }).format(now)} (${timezone})`;

/** The user's words, with what changed since their last message: the time, and background work that ended. */
export const buildUserTurn = (
    text: string,
    context: { now: Date; timezone: string; finished: readonly BackgroundTask[]; running: readonly BackgroundTask[] },
): string => {
    const lines = [`Now: ${formatNow(context.now, context.timezone)}`];
    for (const task of context.finished) {
        lines.push(`Background task "${task.title}" ${task.status}; the user was sent: ${task.result ?? "(nothing)"}`);
    }
    for (const task of context.running) lines.push(`Still running in the background: "${task.title}" (${task.id})`);
    return `<context>\n${lines.join("\n")}\n</context>\n\n${text}`;
};
