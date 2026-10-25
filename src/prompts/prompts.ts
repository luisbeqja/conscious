import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BackgroundTask, Lane } from "../agents/background-agents.js";
import { MAX_NOTES_CHARS, type RestingAgent } from "../agents/resting-agents.js";
import { SEND_MESSAGE } from "../capabilities/chat/capability.js";
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
    /** The user's agents for background jobs. Only the orchestrator sees the list. */
    agents?: string;
}

const fill = (template: string, capabilities: string, context: PromptContext = {}): string => {
    const parts = [template.replace("{{capabilities}}", capabilities)];
    if (context.skills !== undefined) parts.push(SKILLS.replace("{{skills}}", context.skills));
    if (context.memory !== undefined) parts.push(`# What you remember about the user\n\n${context.memory}`);
    return parts.join("\n\n");
};

export const buildSystemPrompt = (capabilities: string, context: PromptContext = {}): string => {
    const parts = [fill(SYSTEM, capabilities, context)];
    if (context.agents !== undefined) {
        parts.push(
            `# Your agents\n\nEach did background jobs of one kind before and kept a notebook. Give a job of the same kind to its agent with \`agent\` in background_start_task.\n\n${context.agents}`,
        );
    }
    if (context.firstMeeting) parts.push(FIRST_MEETING);
    return parts.join("\n\n");
};

/**
 * A background agent never runs the first meeting: it has a job of its own, and a method chosen
 * for it. An agent woken for the job also gets what it kept from its earlier jobs.
 */
export const buildBackgroundPrompt = (
    capabilities: string,
    context?: PromptContext,
    instructions?: string,
    agent?: string,
): string => {
    const parts = [fill(BACKGROUND, capabilities, context)];
    if (agent) parts.push(agent);
    if (instructions) parts.push(`# How to do this job\n\n${instructions}`);
    return parts.join("\n\n");
};

/** Who the agent is and what it kept: its method, its notebook, its last jobs. */
export const buildAgentSection = (
    agent: RestingAgent,
    notes: string,
    runs: readonly string[],
    /** Where each job's brief and answer are, when the agent can open them. */
    runsFolder?: string,
): string => {
    const before = agent.jobs
        ? `You have done this kind of job for them ${agent.jobs} time${agent.jobs === 1 ? "" : "s"}, the last on ${agent.last}.`
        : "This is your first job of this kind for them.";
    const notebook =
        notes.length > MAX_NOTES_CHARS
            ? `${notes.slice(0, MAX_NOTES_CHARS)}\n…(cut: it is too long, merge lines when you rewrite it)`
            : notes;
    const parts = [
        `# You are the user's ${agent.name} agent\n\n${agent.description}. ${before} Your method is for every job of this kind; this job's details are in your brief. Between jobs you keep a notebook: trust it for how to work and what they like, and check again anything that changes, such as prices, times and availability.`,
        `## Your method\n\n${agent.method || "Not written down yet: work it out, and note what worked."}`,
        `## Your notebook\n\n${notebook || "Empty so far."}`,
    ];
    if (runs.length) {
        const where = runsFolder ? `\n\nThe brief and the answer of each are in ${runsFolder} on your computer.` : "";
        parts.push(`## Your last jobs\n\n${runs.join("\n")}${where}`);
    }
    return parts.join("\n\n");
};

/** What the user saw of one message in the conversation: their words, or what Conscious sent them. */
const shownOf = (message: AgentMessage): string[] => {
    if (message.role === "user") {
        const text =
            typeof message.content === "string"
                ? message.content
                : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
        const said = text.replace(/^<context>[\s\S]*?<\/context>\s*/, "").trim();
        return said ? [`User: ${said.slice(0, 600)}`] : [];
    }
    if (message.role !== "assistant") return [];
    // Conscious's own text was never shown; only its messages were.
    return message.content.flatMap((block) =>
        block.type === "toolCall" && block.name === SEND_MESSAGE && typeof block.arguments.text === "string"
            ? [`You: ${block.arguments.text.slice(0, 600)}`]
            : [],
    );
};

/** The end of the conversation as plain lines, for a background agent that cannot see it. */
export const renderRecentChat = (history: readonly AgentMessage[], latest: string, limit = 12): string =>
    [...history.flatMap(shownOf), `User: ${latest}`].slice(-limit).join("\n");

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
        `${task.brief}\n\nThis job was split into parts that other agents already worked on. Here is what they found. Check what matters, fill gaps only if you must, and send the user the result.\n\n${found}`,
        task,
    );
};

/** One part of a split job. Its answer goes to the agent that puts the parts together, not to the user. */
export const buildLaneBrief = (task: BackgroundTask, lane: Lane): string =>
    withChat(
        `You are doing one part of a bigger job, while other agents do the other parts at the same time.\n\nThe whole job: ${task.brief}\n\nYour part, "${lane.title}": ${lane.brief}\n\nYour final text goes to the agent that puts all parts together, not to the user, so write dense findings: names, prices, times, links, and what you could not check. Do not message the user unless something is urgent.`,
        task,
    );

/** The user changed the plan while the job runs. */
export const buildSteeringMessage = (text: string): string =>
    `The user added this while you work, passed on from the chat. It wins over the brief where they differ:\n${text}`;

export const buildCheckBrief = (title: string, job: string): string =>
    `This is a scheduled check the user set up: "${title}". It runs on its own, so the user is not waiting for it.

${job}

If there is something the user should hear, send it with ${SEND_MESSAGE} in one message, written the way a friend would text it, not as a report. If there is nothing new or worth a message, send nothing: the user then gets no message.`;

/**
 * For an agent about to stop without having sent anything: the one more turn it gets to send what it
 * forgot. What it wrote instead is quoted, so it cannot take that text for an answer that went out.
 */
export const buildNothingSentNote = (forThe: "message" | "job", wrote: string): string => {
    const quote = wrote.length > 200 ? `${wrote.slice(0, 199)}…` : wrote;
    const what = wrote
        ? `Not delivered: the user did not see "${quote}". Text you write outside ${SEND_MESSAGE} never reaches them.`
        : `You have sent the user nothing for this ${forThe}, and only ${SEND_MESSAGE} reaches them.`;
    const next =
        forThe === "job"
            ? `Send them the result with ${SEND_MESSAGE} now, then finish with your notes.`
            : `Send what they should read with ${SEND_MESSAGE} now. If silence really is the answer, end without writing anything.`;
    return `<context>\n${what} ${next}\n</context>`;
};

const byAgent = (task: BackgroundTask): string => (task.agent ? ` by the ${task.agent.name} agent` : "");

const describeRunning = (task: BackgroundTask, now: Date): string => {
    const minutes = Math.max(0, Math.round((now.getTime() - task.startedAt.getTime()) / 60_000));
    const parts = [
        `Still running in the background: "${task.title}" (${task.id})${byAgent(task)}, for ${minutes} min, ${task.steps} steps so far`,
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

const describeFinished = (task: BackgroundTask): string => {
    const parts = [`Background task "${task.title}"${byAgent(task)} ${task.status}`];
    if (task.updates.length) parts.push(`it sent the user: ${task.updates.map((update) => `"${update}"`).join(", ")}`);
    if (task.status === "done") parts.push(`its notes for you: ${task.result || "(none)"}`);
    if (task.status === "failed") parts.push(`the user was told it did not finish: ${task.result}`);
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
    for (const task of context.finished) lines.push(describeFinished(task));
    for (const task of context.running) lines.push(describeRunning(task, context.now));
    lines.push(...(context.files ?? []));
    return `<context>\n${lines.join("\n")}\n</context>\n\n${text}`;
};
