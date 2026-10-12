import type { BackgroundAgents, BackgroundTask } from "../agents/background-agents.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import type { Capability, ToolContext } from "../capabilities/types.js";
import type { Channel, InboundMessage } from "../channels/channel.js";
import type { Budgets } from "../config.js";
import type { ConversationStore } from "../conversations/store.js";
import { buildBackgroundPrompt, buildSystemPrompt, buildUserTurn } from "../prompts/prompts.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { ModelRuntime } from "./models.js";
import { runAgent } from "./run-agent.js";
import { adaptTool } from "./tool-adapter.js";

export interface OrchestratorDeps {
    registry: CapabilityRegistry;
    store: ConversationStore;
    channel: Channel;
    runtime: ModelRuntime;
    budgets: Budgets;
    timezone: string;
    scheduler: Scheduler;
    background: BackgroundAgents;
}

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
 */
export class Orchestrator {
    private readonly queues = new Map<string, Promise<void>>();

    constructor(private readonly deps: OrchestratorDeps) {}

    /** Returns at once; the reply goes out on the channel. */
    receive(message: InboundMessage): Promise<void> {
        const previous = this.queues.get(message.userId) ?? Promise.resolve();
        const next = previous
            .then(() => this.handle(message))
            .catch((error) => {
                console.error(`[orchestrator] message ${message.messageId} failed`, error);
            });
        this.queues.set(message.userId, next);
        return next;
    }

    private async handle(message: InboundMessage): Promise<void> {
        const { store, channel, registry, runtime, budgets, timezone, scheduler } = this.deps;
        if (!(await store.claim(message.userId, message.messageId))) return;

        const { background } = this.deps;
        const capabilities = await registry.available(message.userId);
        const { tools, effects } = toolsFor(capabilities, { userId: message.userId, timezone, scheduler, background });
        const result = await runAgent({
            runtime,
            systemPrompt: buildSystemPrompt(registry.renderIndex(capabilities)),
            tools,
            effects,
            history: await store.load(message.userId),
            prompt: buildUserTurn(message.text, {
                now: new Date(),
                timezone,
                finished: background.takeUnreported(message.userId),
                running: background.running(message.userId),
            }),
            budgets,
            sessionId: message.userId,
        });
        await store.save(message.userId, result.messages);
        await channel.send(
            message.userId,
            result.text || "Sorry, something went wrong on my side. Try again in a moment?",
        );
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
            systemPrompt: buildBackgroundPrompt(registry.renderIndex(capabilities)),
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
}
