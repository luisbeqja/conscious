import {
    type BackgroundAgents,
    type BackgroundTask,
    deadlineOf,
    EFFORT,
    type Harness,
} from "../agents/background-agents.js";
import { taskCapability } from "../capabilities/background/capability.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import type { Capability, ToolContext } from "../capabilities/types.js";
import type { Budgets } from "../config.js";
import type { ConversationStore } from "../conversations/store.js";
import { type IncomingFile, type OutgoingFile, prepareFiles, withoutImages } from "../media/incoming.js";
import { emptyMemory, isEmpty, type MemoryStore, renderMemory, SandboxMemoryStore } from "../memory/memory.js";
import {
    buildBackgroundPrompt,
    buildCheckBrief,
    buildLaneBrief,
    buildSteeringMessage,
    buildSystemPrompt,
    buildTaskBrief,
    buildUserTurn,
    isNothing,
    type PromptContext,
    renderRecentChat,
} from "../prompts/prompts.js";
import { loadOlderNotes, OLDER_NOTES } from "../sandbox/memory.js";
import type { SandboxProvider } from "../sandbox/sandbox.js";
import type { Reminder, Scheduler } from "../scheduler/scheduler.js";
import type { SkillLibrary } from "../skills/library.js";
import type { ModelRuntime } from "./models.js";
import { type RunProgress, runAgent } from "./run-agent.js";
import { adaptTool } from "./tool-adapter.js";

export interface OrchestratorDeps {
    registry: CapabilityRegistry;
    store: ConversationStore;
    runtime: ModelRuntime;
    budgets: Budgets;
    timezone: string;
    scheduler: Scheduler;
    background: BackgroundAgents;
    /** The users' computers, for skills and files. */
    sandboxes?: SandboxProvider;
    /** What Conscious remembers about each user. Defaults to their computer when there is one. */
    memory?: MemoryStore;
    /** The skills on each computer. Only used with `sandboxes`. */
    skills?: SkillLibrary;
    /** Messages Conscious sent on its own since the user last wrote, so the next answer knows about them. */
    sent?: SentLog;
}

/** How one background run is set up and limited. */
interface RunOptions {
    signal?: AbortSignal;
    deadline?: number;
    budgets?: Budgets;
    harness?: Harness;
    task?: ToolContext["task"];
    onProgress?: (progress: RunProgress) => void;
    steering?: () => string[];
}

export class SentLog {
    private readonly pending = new Map<string, string[]>();

    record(userId: string, text: string): void {
        this.pending.set(userId, [...(this.pending.get(userId) ?? []), text]);
    }

    take(userId: string): string[] {
        const sent = this.pending.get(userId) ?? [];
        this.pending.delete(userId);
        return sent;
    }
}

/** How the user's chat takes part in one answer. */
export interface SendOptions {
    /** Live progress, for a terminal or a typing indicator. */
    onProgress?: (progress: RunProgress) => void;
    /** Reacts to the message being answered. Without it the agent cannot react. */
    react?: (emoji: string) => Promise<boolean>;
    /** Files that came with the message. */
    files?: readonly IncomingFile[];
    /** Sends a file into the chat. Without it the agent cannot send files. */
    sendFile?: (file: OutgoingFile) => Promise<void>;
}

const FALLBACK = "Oops, something broke on my side. Try me again in a minute?";

const toolsFor = (capabilities: readonly Capability[], context: ToolContext) => {
    const registered = capabilities.flatMap((capability) => capability.tools);
    return {
        tools: registered.map((tool) => adaptTool(tool, context)),
        effects: new Map(registered.map((tool) => [tool.name, tool.effect])),
    };
};

/**
 * The agent the user talks to. One message at a time per user, in the order they arrive;
 * long work goes to background agents so the conversation never waits on it.
 * It knows nothing about where the user is: the terminal today, WhatsApp later.
 */
export class Orchestrator {
    private readonly queues = new Map<string, Promise<unknown>>();
    private readonly memory?: MemoryStore;

    constructor(private readonly deps: OrchestratorDeps) {
        this.memory = deps.memory ?? (deps.sandboxes ? new SandboxMemoryStore(deps.sandboxes) : undefined);
    }

    /**
     * Answers one message. Messages from the same user wait for the one before them.
     * An empty answer means a reaction said it all, so there is nothing to send.
     */
    send(userId: string, text: string, options: SendOptions = {}): Promise<string> {
        const previous = this.queues.get(userId) ?? Promise.resolve();
        const next = previous.catch(() => {}).then(() => this.handle(userId, text, options));
        this.queues.set(userId, next);
        return next;
    }

    async reset(userId: string): Promise<void> {
        await this.deps.store.save(userId, []);
    }

    /**
     * Forgets the user entirely, so the next message is a first meeting: the conversation, memory,
     * reminders and checks, and background work. Files and learned skills on their computer stay.
     * Waits for any answer in progress, so nothing half-finished is saved after the wipe.
     */
    startFresh(userId: string): Promise<void> {
        const previous = this.queues.get(userId) ?? Promise.resolve();
        const next = previous
            .catch(() => {})
            .then(async () => {
                const { store, scheduler, background, sandboxes, sent } = this.deps;
                for (const task of background.running(userId)) background.cancel(userId, task.id);
                for (const reminder of scheduler.list(userId)) scheduler.cancel(userId, reminder.id);
                sent?.take(userId);
                await store.save(userId, []);
                await this.memory?.save(userId, emptyMemory());
                if (sandboxes) await (await sandboxes.forUser(userId)).run(`rm -f ${OLDER_NOTES}`);
            });
        this.queues.set(userId, next);
        return next;
    }

    private async handle(userId: string, text: string, options: SendOptions): Promise<string> {
        const { store, registry, runtime, budgets, timezone, scheduler, background } = this.deps;
        const capabilities = (await registry.available(userId)).filter(
            (capability) => options.react || capability.id !== "reactions",
        );
        let reacted = false;
        const react = options.react
            ? async (emoji: string) => {
                  const done = await options.react?.(emoji);
                  reacted ||= done === true;
                  return done === true;
              }
            : undefined;
        const history = await store.load(userId);
        const { tools, effects } = toolsFor(capabilities, {
            userId,
            timezone,
            scheduler,
            background,
            recentChat: renderRecentChat(history, text),
            react,
            sendFile: options.sendFile,
        });
        const files = options.files?.length
            ? await prepareFiles(options.files, {
                  seesImages: runtime.model.input.includes("image"),
                  sandbox: await this.deps.sandboxes?.forUser(userId).catch(() => undefined),
              })
            : { notes: [], images: [] };
        const result = await runAgent({
            runtime,
            systemPrompt: buildSystemPrompt(registry.renderIndex(capabilities), await this.context(userId)),
            tools,
            effects,
            history,
            prompt: buildUserTurn(text, {
                now: new Date(),
                timezone,
                finished: background.takeUnreported(userId),
                running: background.running(userId),
                sent: this.deps.sent?.take(userId),
                files: files.notes,
            }),
            images: files.images,
            budgets,
            sessionId: userId,
            onProgress: options.onProgress,
        });
        await store.save(userId, withoutImages(result.messages));
        if (!result.text && reacted && result.status === "completed") return "";
        return result.text || FALLBACK;
    }

    /**
     * What a background agent runs: its own loop with the capabilities and method the orchestrator
     * chose for the job, never more background work. A job split into parts runs each part in a
     * sub-agent of its own at the same time, then one more puts their findings together.
     */
    runBackgroundTask = async (task: BackgroundTask, signal: AbortSignal): Promise<string> => {
        const { background } = this.deps;
        const effort = EFFORT[task.effort];
        const deadline = deadlineOf(task);
        const options = (): RunOptions => {
            let read = task.messages.length;
            return {
                signal,
                harness: task.harness,
                task: { id: task.id, tellUser: (text) => background.tellUser(task.id, text) },
                onProgress: (progress) => {
                    if (progress.type === "tool") background.progress(task.id, progress.name);
                },
                steering: () => {
                    const fresh = task.messages.slice(read);
                    read = task.messages.length;
                    return fresh.map(buildSteeringMessage);
                },
                deadline,
                budgets: {
                    ...this.deps.budgets,
                    maxTurnsPerRun: effort.maxTurns,
                    maxToolCallsPerRun: effort.maxToolCalls,
                },
            };
        };
        const lanes = task.harness.lanes ?? [];
        // The parts stop early enough to leave time for putting them together.
        const lanesDeadline = task.startedAt.getTime() + (deadline - task.startedAt.getTime()) * 0.75;
        await Promise.all(
            lanes.map(async (lane, index) => {
                lane.status = "running";
                try {
                    lane.result = await this.runAlone(
                        task.userId,
                        `background-${task.id}-${index + 1}`,
                        buildLaneBrief(task, lane),
                        { ...options(), deadline: lanesDeadline },
                    );
                    lane.status = "done";
                } catch (error) {
                    lane.status = "failed";
                    lane.result = error instanceof Error ? error.message : String(error);
                }
            }),
        );
        return this.runAlone(task.userId, `background-${task.id}`, buildTaskBrief(task), options());
    };

    /**
     * A scheduled check firing: an agent does the job on its own. Returns what to send the user,
     * or an empty string when it found nothing worth a message.
     */
    runCheck = async (reminder: Reminder): Promise<string> => {
        const text = await this.runAlone(
            reminder.userId,
            `check-${reminder.id}-${Date.now()}`,
            buildCheckBrief(reminder.text, reminder.check ?? reminder.text),
        );
        return isNothing(text) ? "" : text;
    };

    private async runAlone(userId: string, sessionId: string, brief: string, limits: RunOptions = {}): Promise<string> {
        const { registry, runtime, timezone, scheduler } = this.deps;
        const chosen = new Set(limits.harness?.capabilities ?? []);
        // Its job came from a brief, not a message, so there is nothing to react to.
        const capabilities = [
            ...(await registry.available(userId)).filter(
                (capability) =>
                    capability.id !== "background" &&
                    capability.id !== "reactions" &&
                    // Memory stays: the sub-agent is still Conscious, and knows the user.
                    (!chosen.size || chosen.has(capability.id) || capability.id === "memory"),
            ),
            ...(limits.task ? [taskCapability] : []),
        ];
        const { tools, effects } = toolsFor(capabilities, { userId, timezone, scheduler, task: limits.task });
        const result = await runAgent({
            runtime,
            systemPrompt: buildBackgroundPrompt(
                registry.renderIndex(capabilities),
                await this.context(userId),
                limits.harness?.instructions,
            ),
            tools,
            effects,
            history: [],
            prompt: buildUserTurn(brief, { now: new Date(), timezone, finished: [], running: [] }),
            budgets: limits.budgets ?? this.deps.budgets,
            sessionId,
            signal: limits.signal,
            deadline: limits.deadline,
            onProgress: limits.onProgress,
            steering: limits.steering,
        });
        if (result.status === "failed" || !result.text) throw new Error("the sub-agent did not finish");
        return result.text;
    }

    /** A computer that cannot be reached costs the user their memory and skills for one message, not the answer. */
    private async context(userId: string): Promise<PromptContext> {
        const { sandboxes, skills } = this.deps;
        const unreachable = "(Your computer could not be reached, so this is unavailable for this message.)";
        const failed = (error: unknown) => {
            console.error(`[orchestrator] could not read the computer for ${userId}`, error);
            return unreachable;
        };
        const loaded = await this.memory?.load(userId).catch(failed);
        const memory = typeof loaded === "object" ? renderMemory(loaded) : loaded;
        // Only a memory that was read and is empty means a new user; one that failed to load does not.
        const isNew = typeof loaded === "object" && isEmpty(loaded);
        if (!sandboxes) return { memory, firstMeeting: isNew };
        try {
            const sandbox = await sandboxes.forUser(userId);
            const [notes, skillList] = await Promise.all([
                loadOlderNotes(sandbox),
                skills ? skills.render(userId, sandbox) : "None yet.",
            ]);
            return {
                memory: notes ? `${memory}\n\nOlder notes, from before the memory tools:\n${notes}` : memory,
                skills: skillList,
                firstMeeting: isNew && !notes,
            };
        } catch (error) {
            return { memory, skills: failed(error), firstMeeting: false };
        }
    }
}
