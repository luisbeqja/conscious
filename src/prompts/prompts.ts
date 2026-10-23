import type { BackgroundTask } from "../agents/background-agents.js";
import { promptFile } from "./prompt-file.js";

const SYSTEM = promptFile(import.meta.url, "system.md");
const BACKGROUND = promptFile(import.meta.url, "background.md");
const SKILLS = promptFile(import.meta.url, "skills.md");
const FIRST_MEETING = promptFile(import.meta.url, "first-meeting.md");

/** What goes into the prompt besides the capabilities. A part left out is not shown at all. */
export interface PromptContext {
    /** What Conscious remembers about the user. */
    memory?: string;
    /** The skills on the user's computer. Only with a computer. */
    skills?: string;
    /** Conscious knows nothing about the user yet, so it starts by getting to know them. */
    firstMeeting?: boolean;
}

const fill = (template: string, capabilities: string, context: PromptContext = {}): string => {
    const parts = [template.replace("{{capabilities}}", capabilities)];
    if (context.skills !== undefined) parts.push(SKILLS.replace("{{skills}}", context.skills));
    if (context.memory !== undefined) parts.push(`# What you remember about the user\n\n${context.memory}`);
    return parts.join("\n\n");
};

export const buildSystemPrompt = (capabilities: string, context: PromptContext = {}): string => {
    const prompt = fill(SYSTEM, capabilities, context);
    return context.firstMeeting ? `${prompt}\n\n${FIRST_MEETING}` : prompt;
};

/** A background agent never runs the first meeting: it has a job of its own. */
export const buildBackgroundPrompt = (capabilities: string, context?: PromptContext): string =>
    fill(BACKGROUND, capabilities, context);

/** What a scheduled check's agent answers when there is nothing to tell the user. */
const NOTHING = "NOTHING";

export const isNothing = (text: string): boolean => text.trim().replace(/[.*_]/g, "").toUpperCase() === NOTHING;

export const buildCheckBrief = (title: string, job: string): string =>
    `This is a scheduled check the user set up: "${title}". It runs on its own, so the user is not waiting for it.

${job}

If there is something the user should hear, your final answer is that message, written the way a friend would text it, not as a report. If there is nothing new or worth a message, answer exactly ${NOTHING} and nothing else: the user then gets no message.`;

const formatNow = (now: Date, timezone: string): string =>
    `${new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "short", timeZone: timezone }).format(now)} (${timezone})`;

/** The user's words, with what changed since their last message: the time, and background work that ended. */
export const buildUserTurn = (
    text: string,
    context: {
        now: Date;
        timezone: string;
        finished: readonly BackgroundTask[];
        running: readonly BackgroundTask[];
        /** What Conscious said on its own since the last message: reminders, accounts connected. */
        sent?: readonly string[];
        /** What came with the message: photos, documents, and where they were saved. */
        files?: readonly string[];
    },
): string => {
    const lines = [`Now: ${formatNow(context.now, context.timezone)}`];
    for (const text of context.sent ?? []) lines.push(`You messaged the user on your own: ${text}`);
    for (const task of context.finished) {
        lines.push(`Background task "${task.title}" ${task.status}; the user was sent: ${task.result ?? "(nothing)"}`);
    }
    for (const task of context.running) lines.push(`Still running in the background: "${task.title}" (${task.id})`);
    lines.push(...(context.files ?? []));
    return `<context>\n${lines.join("\n")}\n</context>\n\n${text}`;
};
