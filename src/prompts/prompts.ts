import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BackgroundTask, Lane } from "../agents/background-agents.js";
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

/** A background agent never runs the first meeting: it has a job of its own, and a method chosen for it. */
export const buildBackgroundPrompt = (capabilities: string, context?: PromptContext, instructions?: string): string => {
    const prompt = fill(BACKGROUND, capabilities, context);
    return instructions ? `${prompt}\n\n# How to do this job\n\n${instructions}` : prompt;
};

const textOf = (message: AgentMessage): string => {
    if (message.role !== "user" && message.role !== "assistant") return "";
    const text =
        typeof message.content === "string"
            ? message.content
            : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    return text.replace(/^<context>[\s\S]*?<\/context>\s*/, "").trim();
};

/** The end of the conversation as plain lines, for a background agent that cannot see it. */
export const renderRecentChat = (history: readonly AgentMessage[], latest: string, limit = 12): string =>
    [
        ...history.flatMap((message) => {
            const text = textOf(message);
            return text ? [`${message.role === "user" ? "User" : "You"}: ${text.slice(0, 600)}`] : [];
        }),
        `User: ${latest}`,
    ]
        .slice(-limit)
        .join("\n");

const withChat = (brief: string, task: BackgroundTask): string => {
    const parts = [brief];
    if (task.messages.length) {
        parts.push(`The user added this after the job started; it wins over the brief:\n${task.messages.join("\n")}`);
    }
    if (task.restarts && task.updates.length) {
        parts.push(
            `You started this job before and were interrupted. You already texted the user:\n${task.updates.join("\n")}`,
        );
    }
    if (task.recentChat) {
        parts.push(`The chat just before this job started, for context (the job is above):\n${task.recentChat}`);
    }
    return parts.join("\n\n");
};

/** What a background agent is asked: its brief, the chat that led to it, and what its parts found. */
export const buildTaskBrief = (task: BackgroundTask): string => {
    const lanes = task.harness.lanes ?? [];
    if (!lanes.length) return withChat(task.brief, task);
    const found = lanes
        .map((lane) => `## ${lane.title} (${lane.status === "done" ? "done" : "failed"})\n${lane.result ?? ""}`)
        .join("\n\n");
    return withChat(
        `${task.brief}\n\nThis job was split into parts that other agents already worked on. Here is what they found. Check what matters, fill gaps only if you must, and write the final answer.\n\n${found}`,
        task,
    );
};

/** One part of a split job. Its answer goes to the agent that puts the parts together, not to the user. */
export const buildLaneBrief = (task: BackgroundTask, lane: Lane): string =>
    withChat(
        `You are doing one part of a bigger job, while other agents do the other parts at the same time.\n\nThe whole job: ${task.brief}\n\nYour part, "${lane.title}": ${lane.brief}\n\nYour final answer is not sent to the user. It goes to the agent that puts all parts together, so write dense findings: names, prices, times, links, and what you could not check. Do not text the user unless something is urgent.`,
        task,
    );

/** The user changed the plan while the job runs. */
export const buildSteeringMessage = (text: string): string =>
    `The user added this while you work, passed on from the chat. It wins over the brief where they differ:\n${text}`;

/** What a scheduled check's agent answers when there is nothing to tell the user. */
const NOTHING = "NOTHING";

export const isNothing = (text: string): boolean => text.trim().replace(/[.*_]/g, "").toUpperCase() === NOTHING;

export const buildCheckBrief = (title: string, job: string): string =>
    `This is a scheduled check the user set up: "${title}". It runs on its own, so the user is not waiting for it.

${job}

If there is something the user should hear, your final answer is that message, written the way a friend would text it, not as a report. If there is nothing new or worth a message, answer exactly ${NOTHING} and nothing else: the user then gets no message.`;

const describeRunning = (task: BackgroundTask, now: Date): string => {
    const minutes = Math.max(0, Math.round((now.getTime() - task.startedAt.getTime()) / 60_000));
    const parts = [
        `Still running in the background: "${task.title}" (${task.id}), for ${minutes} min, ${task.steps} steps so far`,
    ];
    if (task.lastStep) parts.push(`last step ${task.lastStep}`);
    const lanes = task.harness.lanes ?? [];
    if (lanes.length) {
        parts.push(
            `${lanes.filter((lane) => lane.status && lane.status !== "running").length} of ${lanes.length} parts done`,
        );
    }
    const told = task.updates.map((update) => `"${update}"`).join(", ");
    if (told) parts.push(`it already texted the user: ${told}`);
    return parts.join("; ");
};

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
    for (const task of context.running) lines.push(describeRunning(task, context.now));
    lines.push(...(context.files ?? []));
    return `<context>\n${lines.join("\n")}\n</context>\n\n${text}`;
};
