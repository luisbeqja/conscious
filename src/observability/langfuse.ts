import { createHash } from "node:crypto";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
    type LangfuseAgent,
    type LangfuseGeneration,
    type LangfuseTool,
    propagateAttributes,
    startObservation,
} from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { RunTrace, Tracer, TraceStart } from "./tracing.js";

export interface LangfuseConfig {
    publicKey: string;
    secretKey: string;
    /** https://cloud.langfuse.com (EU), https://us.cloud.langfuse.com, or your own. */
    baseUrl: string;
    /** Send what was said and what the tools saw and returned, not only names, timings and costs. */
    content: boolean;
    environment?: string;
}

// A page's tree runs to hundreds of thousands of characters: enough to see what the agent saw.
const MAX_CHARS = 8_000;

const clip = (value: unknown): unknown => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text === undefined || text.length <= MAX_CHARS) return value;
    return `${text.slice(0, MAX_CHARS)}… (${text.length - MAX_CHARS} more characters)`;
};

/** Ids are phone numbers: Langfuse sees a short hash, the same for the same user. */
export const userHash = (userId: string): string => createHash("sha256").update(userId).digest("hex").slice(0, 12);

/** What a tool returned, as text: the parts a model reads, without pictures. */
const resultText = (result: unknown): unknown => {
    const content = (result as { content?: unknown })?.content;
    if (!Array.isArray(content)) return result;
    return content
        .map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text : `[${part.type}]`))
        .join("\n");
};

/** What the model answered: its words and the tools it called. Thinking stays out. */
const answerOf = (message: AssistantMessage): unknown =>
    message.content.flatMap((part): Record<string, unknown>[] => {
        if (part.type === "text") return part.text.trim() ? [{ text: part.text }] : [];
        if (part.type === "toolCall") return [{ tool: part.name, arguments: part.arguments }];
        return [];
    });

const isAssistant = (message: AgentMessage): message is AssistantMessage =>
    (message as { role?: string }).role === "assistant";

class LangfuseRunTrace implements RunTrace {
    private turn = 0;
    private generation?: LangfuseGeneration;
    private readonly tools = new Map<string, LangfuseTool>();

    constructor(
        private readonly root: LangfuseAgent,
        private readonly run: TraceStart,
        private readonly content: boolean,
    ) {}

    event(event: AgentEvent): void {
        try {
            this.handle(event);
        } catch (error) {
            // Tracing must never break a run.
            console.warn("[langfuse] could not trace an event:", error instanceof Error ? error.message : error);
        }
    }

    private handle(event: AgentEvent): void {
        if (event.type === "turn_start") {
            this.turn += 1;
            this.generation = this.root.startObservation(
                `turn ${this.turn}`,
                { model: this.run.model, ...(this.content && this.turn === 1 ? { input: clip(this.run.input) } : {}) },
                { asType: "generation" },
            );
            return;
        }
        if (event.type === "message_end" && isAssistant(event.message) && this.generation) {
            const message = event.message;
            const usage = message.usage;
            const failed = message.stopReason === "error" || message.stopReason === "aborted";
            this.generation
                .update({
                    model: message.model || this.run.model,
                    ...(this.content ? { output: answerOf(message) } : {}),
                    ...(usage
                        ? {
                              usageDetails: {
                                  input: usage.input,
                                  output: usage.output,
                                  cache_read_input_tokens: usage.cacheRead,
                                  cache_creation_input_tokens: usage.cacheWrite,
                              },
                              costDetails: { total: usage.cost.total },
                          }
                        : {}),
                    metadata: { stopReason: message.stopReason },
                    ...(failed
                        ? { level: "ERROR" as const, statusMessage: message.errorMessage ?? message.stopReason }
                        : {}),
                })
                .end();
            this.generation = undefined;
            return;
        }
        if (event.type === "tool_execution_start") {
            this.tools.set(
                event.toolCallId,
                this.root.startObservation(event.toolName, this.content ? { input: clip(event.args) } : {}, {
                    asType: "tool",
                }),
            );
            return;
        }
        if (event.type === "tool_execution_end") {
            const tool = this.tools.get(event.toolCallId);
            if (!tool) return;
            this.tools.delete(event.toolCallId);
            const text = resultText(event.result);
            tool.update({
                ...(this.content ? { output: clip(text) } : {}),
                ...(event.isError ? { level: "ERROR" as const, statusMessage: String(clip(text)).slice(0, 500) } : {}),
            }).end();
        }
    }

    end(outcome: { status: string; text: string; error?: string }): void {
        try {
            this.generation?.end();
            for (const tool of this.tools.values()) tool.end();
            const failed = outcome.status !== "completed";
            this.root
                .update({
                    ...(this.content && outcome.text ? { output: clip(outcome.text) } : {}),
                    metadata: { status: outcome.status, turns: this.turn },
                    ...(failed || outcome.error
                        ? {
                              level: outcome.error || outcome.status === "failed" ? "ERROR" : "WARNING",
                              statusMessage: outcome.error ?? outcome.status,
                          }
                        : {}),
                })
                .end();
        } catch (error) {
            console.warn("[langfuse] could not end a trace:", error instanceof Error ? error.message : error);
        }
    }
}

/**
 * Every agent run as a Langfuse trace: the model's turns with tokens and cost, each tool call with
 * what it was asked and what it returned, and errors marked. One trace per message or job, grouped
 * in a session per user and day.
 */
export const createLangfuseTracer = (config: LangfuseConfig): Tracer => {
    const processor = new LangfuseSpanProcessor({
        publicKey: config.publicKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl,
        environment: config.environment,
    });
    const sdk = new NodeSDK({ spanProcessors: [processor] });
    sdk.start();
    return {
        start: (run) => {
            const user = userHash(run.userId);
            const day = new Date().toISOString().slice(0, 10);
            const root = propagateAttributes(
                { userId: user, sessionId: `${user}-${day}`, traceName: run.name, tags: [run.name] },
                () => startObservation(run.name, config.content ? { input: clip(run.input) } : {}, { asType: "agent" }),
            );
            return new LangfuseRunTrace(root, run, config.content);
        },
        flush: () => processor.forceFlush(),
    };
};
