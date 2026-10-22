import type { BackgroundAgents, BackgroundTask } from "../agents/background-agents.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import type { Capability, ToolContext } from "../capabilities/types.js";
import type { Budgets } from "../config.js";
import type { ConversationStore } from "../conversations/store.js";
import { buildBackgroundPrompt, buildSystemPrompt, buildUserTurn, type ComputerContext } from "../prompts/prompts.js";
import { loadMemory } from "../sandbox/memory.js";
import type { SandboxProvider } from "../sandbox/sandbox.js";
import type { Scheduler } from "../scheduler/scheduler.js";
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

    /** Answers one message. Messages from the same user wait for the one before them. */
    send(userId: string, text: string, onProgress?: (progress: RunProgress) => void): Promise<string> {
        const previous = this.queues.get(userId) ?? Promise.resolve();
        const next = previous.catch(() => {}).then(() => this.handle(userId, text, onProgress));
        this.queues.set(userId, next);
        return next;
    }

    async reset(userId: string): Promise<void> {
        await this.deps.store.save(userId, []);
    }

    private async handle(userId: string, text: string, onProgress?: (progress: RunProgress) => void): Promise<string> {
        const { store, registry, runtime, budgets, timezone, scheduler, background } = this.deps;
        const capabilities = await registry.available(userId);
        const { tools, effects } = toolsFor(capabilities, { userId, timezone, scheduler, background });
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
            }),
            budgets,
            sessionId: userId,
            onProgress,
        });
        await store.save(userId, result.messages);
        return result.text || FALLBACK;
    }

    /** What a background agent runs: its own loop, the same capabilities minus starting more background work. */
    runBackgroundTask = async (task: BackgroundTask, signal: AbortSignal): Promise<string> => {
        const { registry, runtime, budgets, timezone, scheduler } = this.deps;
        const capabilities = (await registry.available(task.userId)).filter(
            (capability) => capability.id !== "background",
        );
        const { tools, effects } = toolsFor(capabilities, { userId: task.userId, timezone, scheduler });
        const result = await runAgent({
            runtime,
            systemPrompt: buildBackgroundPrompt(registry.renderIndex(capabilities), await this.computer(task.userId)),
            tools,
            effects,
            history: [],
            prompt: buildUserTurn(task.brief, { now: new Date(), timezone, finished: [], running: [] }),
            budgets,
            sessionId: `background-${task.id}`,
            signal,
        });
        if (result.status === "failed" || !result.text) throw new Error("the sub-agent did not finish");
        return result.text;
    };

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
