import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
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
    budgets: Budgets;
    sessionId: string;
    signal?: AbortSignal;
    /** Live progress, for a terminal or a typing indicator. Never stored. */
    onProgress?: (progress: RunProgress) => void;
}

export type RunProgress = { type: "text"; delta: string } | { type: "tool"; name: string };

export interface AgentRunResult {
    messages: AgentMessage[];
    /** What the agent said last, the text the user receives. */
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
 * One agent loop on pi-agent-core, shared by the orchestrator and every background agent.
 * Everything Conscious-specific is policy around the loop: budgets, and commits held for a yes.
 */
export const runAgent = async (run: AgentRun): Promise<AgentRunResult> => {
    let toolCalls = 0;
    let status: AgentRunResult["status"] = "completed";
    const agent = new Agent({
        initialState: {
            systemPrompt: run.systemPrompt,
            model: run.runtime.model,
            thinkingLevel: "low",
            tools: run.tools,
            messages: run.history,
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
            if (++toolCalls > run.budgets.maxToolCallsPerRun) {
                status = "budget_exhausted";
                return {
                    block: true,
                    reason: "The tool budget for this message is used up. Answer with what you have.",
                };
            }
            return undefined;
        },
    });

    let turns = 0;
    agent.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            run.onProgress?.({ type: "text", delta: event.assistantMessageEvent.delta });
        }
        if (event.type === "tool_execution_start") run.onProgress?.({ type: "tool", name: event.toolName });
        if (event.type === "turn_end" && ++turns >= run.budgets.maxTurnsPerRun) {
            status = "budget_exhausted";
            agent.abort();
        }
    });
    const onAbort = () => agent.abort();
    run.signal?.addEventListener("abort", onAbort, { once: true });
    try {
        await agent.prompt(run.prompt);
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
    return { messages: agent.state.messages, text: lastAssistantText(agent.state.messages), status };
};
