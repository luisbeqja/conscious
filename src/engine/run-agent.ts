import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
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
    /** Tools that still run past the deadline and the tool budget, like an agent's notebook. */
    lastWords?: ReadonlySet<string>;
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
            // What the agent learned is worth keeping most when the job ran long.
            if (run.lastWords?.has(toolCall.name)) return undefined;
            const save = run.lastWords?.size
                ? ` If you have not saved your notebook, save it now with ${[...run.lastWords].join(" or ")}.`
                : "";
            if (run.deadline && Date.now() > run.deadline) {
                status = "budget_exhausted";
                return {
                    block: true,
                    reason: `Time is up for this job. Stop using tools and write your final answer with what you have.${save}`,
                };
            }
            if (++toolCalls > run.budgets.maxToolCallsPerRun) {
                status = "budget_exhausted";
                return {
                    block: true,
                    reason: `The tool budget for this message is used up. Answer with what you have.${save}`,
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
        if (event.type !== "turn_end") return;
        if (++turns >= run.budgets.maxTurnsPerRun) {
            status = "budget_exhausted";
            agent.abort();
            return;
        }
        for (const text of run.steering?.() ?? []) agent.steer({ role: "user", content: text, timestamp: Date.now() });
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
        // Only this run: an answer to an earlier message must never be sent again.
        text: lastAssistantText(messages.slice(history.length)),
        status,
    };
};
