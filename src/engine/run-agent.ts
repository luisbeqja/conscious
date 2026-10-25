import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEvent, ImageContent } from "@earendil-works/pi-ai";
import { SEND_MESSAGE } from "../capabilities/chat/capability.js";
import type { Effect } from "../capabilities/types.js";
import type { Budgets } from "../config.js";
import type { ModelRuntime } from "./models.js";

export interface AgentRun {
    runtime: ModelRuntime;
    systemPrompt: string;
    tools: AgentTool[];
    effects: ReadonlyMap<string, Effect>;
    history: AgentMessage[];
    prompt: string;
    /** Photos sent with the prompt. */
    images?: ImageContent[];
    budgets: Budgets;
    sessionId: string;
    signal?: AbortSignal;
    /** Epoch ms after which no tool runs and the agent answers with what it has. */
    deadline?: number;
    /** New instructions that arrived during the run, read after each turn. */
    steering?: () => string[];
    /** Tools that still run past the deadline and the tool budget, like an agent's notebook. Messages always do. */
    lastWords?: ReadonlySet<string>;
    /** Asked when the agent is about to stop, with the text it ended on. A note returned goes to it, and it goes on. */
    beforeStop?: (wrote: string) => string | undefined;
    /** Live progress, for a terminal or a typing indicator. Never stored. */
    onProgress?: (progress: RunProgress) => void;
}

/** `text` is a message to the user as it is written, `tool` a step of the work. The agent's own text is never shown. */
export type RunProgress = { type: "text"; delta: string } | { type: "tool"; name: string };

export interface AgentRunResult {
    messages: AgentMessage[];
    /** What the agent wrote last, outside any message to the user: a part's findings, a job's notes. */
    text: string;
    status: "completed" | "failed" | "budget_exhausted";
}

export const lastAssistantText = (messages: readonly AgentMessage[]): string => {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.role !== "assistant") continue;
        const text = message.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n")
            .trim();
        if (text) return text;
    }
    return "";
};

/**
 * What is new in a message to the user being written, from the call that sends it. `written` keeps what
 * each call (by its place in the reply) showed so far. Empty for anything else the model writes.
 */
const newlyWritten = (update: AssistantMessageEvent, written: Map<number, string>): string => {
    if (update.type !== "toolcall_delta" && update.type !== "toolcall_end") return "";
    const call = update.type === "toolcall_end" ? update.toolCall : update.partial.content[update.contentIndex];
    if (call?.type !== "toolCall" || call.name !== SEND_MESSAGE || typeof call.arguments.text !== "string") return "";
    const text = call.arguments.text;
    const before = written.get(update.contentIndex) ?? "";
    // Arguments arrive as half-parsed JSON; a guess that changed earlier text is skipped, the message shows whole.
    if (text.length <= before.length || !text.startsWith(before)) return "";
    written.set(update.contentIndex, text);
    return text.slice(before.length);
};

/**
 * One agent loop on pi-agent-core, shared by the orchestrator and every background agent.
 * Everything Conscious-specific is policy around the loop: budgets, commits held for a yes, and
 * messages to the user, which are the only thing of the agent's the user sees.
 */
export const runAgent = async (run: AgentRun): Promise<AgentRunResult> => {
    let toolCalls = 0;
    const history = run.history.filter((message) => message.role !== "system");
    let status: AgentRunResult["status"] = "completed";
    const agent = new Agent({
        initialState: {
            systemPrompt: run.systemPrompt,
            model: run.runtime.model,
            thinkingLevel: "low",
            tools: run.tools,
            // A saved system message would win over this run's prompt and tools, and the prompt
            // changes between messages (memory, capabilities), so the transcript never carries one.
            messages: history,
        },
        streamFn: run.runtime.streamFn,
        sessionId: run.sessionId,
        beforeToolCall: async ({ toolCall }) => {
            if (run.effects.get(toolCall.name) === "commit") {
                // Approvals are not built yet, so nothing that acts in the world on its own runs.
                return {
                    block: true,
                    reason: "This acts on the user's behalf and needs their explicit yes, which is not built yet. Tell them what you would do instead.",
                };
            }
            // What the user is told, and what the agent learned, matter most when the job ran long.
            if (toolCall.name === SEND_MESSAGE || run.lastWords?.has(toolCall.name)) return undefined;
            const save = run.lastWords?.size
                ? ` If you have not saved your notebook, save it now with ${[...run.lastWords].join(" or ")}.`
                : "";
            if (run.deadline && Date.now() > run.deadline) {
                status = "budget_exhausted";
                return {
                    block: true,
                    reason: `Time is up for this job. Use no tool but ${SEND_MESSAGE}, and finish with what you have.${save}`,
                };
            }
            if (++toolCalls > run.budgets.maxToolCallsPerRun) {
                status = "budget_exhausted";
                return {
                    block: true,
                    reason: `The tool budget for this message is used up. Use no tool but ${SEND_MESSAGE}, and finish with what you have.${save}`,
                };
            }
            return undefined;
        },
    });

    let turns = 0;
    let written = new Map<number, string>();
    agent.subscribe((event) => {
        if (event.type === "message_start") written = new Map();
        if (event.type === "message_update") {
            const delta = newlyWritten(event.assistantMessageEvent, written);
            if (delta) run.onProgress?.({ type: "text", delta });
        }
        // Sending a message is not a step of the work: the message itself shows.
        if (event.type === "tool_execution_start" && event.toolName !== SEND_MESSAGE) {
            run.onProgress?.({ type: "tool", name: event.toolName });
        }
        if (event.type !== "turn_end") return;
        if (++turns >= run.budgets.maxTurnsPerRun) {
            status = "budget_exhausted";
            agent.abort();
            return;
        }
        const steering = run.steering?.() ?? [];
        for (const text of steering) agent.steer({ role: "user", content: text, timestamp: Date.now() });
        // A reply with no tool calls, and nothing new from the user: the agent is about to stop.
        const { message } = event;
        const stopping =
            message.role === "assistant" &&
            (message.stopReason === "stop" || message.stopReason === "length") &&
            !message.content.some((block) => block.type === "toolCall");
        const note = stopping && !steering.length ? run.beforeStop?.(lastAssistantText([message])) : undefined;
        if (note) agent.followUp({ role: "user", content: note, timestamp: Date.now() });
    });
    const onAbort = () => agent.abort();
    run.signal?.addEventListener("abort", onAbort, { once: true });
    try {
        await agent.prompt(run.prompt, run.images?.length ? run.images : undefined);
    } catch (error) {
        console.error(`[agent ${run.sessionId}] run failed`, error);
        status = "failed";
    } finally {
        run.signal?.removeEventListener("abort", onAbort);
    }
    if (agent.state.errorMessage) {
        console.error(`[agent ${run.sessionId}] ${agent.state.errorMessage}`);
        status = "failed";
    }
    const messages = agent.state.messages.filter((message) => message.role !== "system");
    return {
        messages,
        // Only this run: what it wrote for an earlier message is not its notes now.
        text: lastAssistantText(messages.slice(history.length)),
        status,
    };
};
