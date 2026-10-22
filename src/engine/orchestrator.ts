import type { BackgroundAgents, BackgroundTask } from "../agents/background-agents.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import type { Capability, ToolContext } from "../capabilities/types.js";
import type { Budgets } from "../config.js";
import type { ConversationStore } from "../conversations/store.js";
import {
    buildBackgroundPrompt,
    buildCheckBrief,
    buildSystemPrompt,
    buildUserTurn,
    type ComputerContext,
    isNothing,
} from "../prompts/prompts.js";
import { loadMemory } from "../sandbox/memory.js";
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
    /** The users' computers. Without them Conscious has no memory beyond the conversation. */
    sandboxes?: SandboxProvider;
    /** The skills on each computer. Only used with `sandboxes`. */
    skills?: SkillLibrary;
    /** Messages Conscious sent on its own since the user last wrote, so the next answer knows about them. */
    sent?: SentLog;
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
}

const FALLBACK = "Sorry, something went wrong on my side. Try again in a moment?";

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

    constructor(private readonly deps: OrchestratorDeps) {}

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
        const { tools, effects } = toolsFor(capabilities, { userId, timezone, scheduler, background, react });
        const result = await runAgent({
            runtime,
            systemPrompt: buildSystemPrompt(registry.renderIndex(capabilities), await this.computer(userId)),
            tools,
            effects,
            history: await store.load(userId),
            prompt: buildUserTurn(text, {
                now: new Date(),
                timezone,
                finished: background.takeUnreported(userId),
                running: background.running(userId),
                sent: this.deps.sent?.take(userId),
            }),
            budgets,
            sessionId: userId,
            onProgress: options.onProgress,
        });
        await store.save(userId, result.messages);
        if (!result.text && reacted && result.status === "completed") return "";
        return result.text || FALLBACK;
    }

    /** What a background agent runs: its own loop, the same capabilities minus starting more background work. */
    runBackgroundTask = async (task: BackgroundTask, signal: AbortSignal): Promise<string> =>
        this.runAlone(task.userId, `background-${task.id}`, task.brief, signal);

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

    private async runAlone(userId: string, sessionId: string, brief: string, signal?: AbortSignal): Promise<string> {
        const { registry, runtime, budgets, timezone, scheduler } = this.deps;
        // Its job came from a brief, not a message, so there is nothing to react to.
        const capabilities = (await registry.available(userId)).filter(
            (capability) => capability.id !== "background" && capability.id !== "reactions",
        );
        const { tools, effects } = toolsFor(capabilities, { userId, timezone, scheduler });
        const result = await runAgent({
            runtime,
            systemPrompt: buildBackgroundPrompt(registry.renderIndex(capabilities), await this.computer(userId)),
            tools,
            effects,
            history: [],
            prompt: buildUserTurn(brief, { now: new Date(), timezone, finished: [], running: [] }),
            budgets,
            sessionId,
            signal,
        });
        if (result.status === "failed" || !result.text) throw new Error("the sub-agent did not finish");
        return result.text;
    }

    /** A computer that cannot be reached costs the user their memory and skills for one message, not the answer. */
    private async computer(userId: string): Promise<ComputerContext | undefined> {
        const { sandboxes, skills } = this.deps;
        if (!sandboxes) return undefined;
        try {
            const sandbox = await sandboxes.forUser(userId);
            const [memory, skillList] = await Promise.all([
                loadMemory(sandbox),
                skills ? skills.render(userId, sandbox) : "None yet.",
            ]);
            return { memory, skills: skillList };
        } catch (error) {
            console.error(`[orchestrator] could not read the computer for ${userId}`, error);
            const unreachable = "(Your computer could not be reached, so this is unavailable for this message.)";
            return { memory: unreachable, skills: unreachable };
        }
    }
}
