import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { BackgroundAgents } from "../src/agents/background-agents.js";
import { createRegistry } from "../src/capabilities/index.js";
import { InMemoryConversationStore } from "../src/conversations/store.js";
import type { ModelRuntime } from "../src/engine/models.js";
import { Orchestrator } from "../src/engine/orchestrator.js";
import { createLangfuseTracer, userHash } from "../src/observability/langfuse.js";
import type { Tracer, TraceStart } from "../src/observability/tracing.js";
import { Scheduler } from "../src/scheduler/scheduler.js";

const scripted = () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime: ModelRuntime = {
        model: faux.getModel(),
        streamFn: (model, context, options) => models.streamSimple(model, context, options),
    };
    return { faux, runtime };
};

describe("tracing", () => {
    it("traces a message: its turns and tool calls, with how it ended", async () => {
        const { faux, runtime } = scripted();
        faux.setResponses([
            fauxAssistantMessage(fauxToolCall("reminders_list_reminders", {}), { stopReason: "toolUse" }),
            fauxAssistantMessage(fauxToolCall("chat_send_message", { text: "No reminders." }), {
                stopReason: "toolUse",
            }),
            fauxAssistantMessage([]),
        ]);
        const started: TraceStart[] = [];
        const events: string[] = [];
        const ended: { status: string }[] = [];
        const tracer: Tracer = {
            start: (run) => {
                started.push(run);
                return {
                    event: (event) => {
                        if (event.type === "tool_execution_end")
                            events.push(`${event.toolName}${event.isError ? " ✗" : ""}`);
                        if (event.type === "turn_start") events.push("turn");
                    },
                    end: (outcome) => void ended.push(outcome),
                };
            },
            flush: async () => {},
        };
        const scheduler = new Scheduler(async () => {});
        const orchestrator = new Orchestrator({
            registry: createRegistry(),
            store: new InMemoryConversationStore(),
            runtime,
            budgets: { maxTurnsPerRun: 10, maxToolCallsPerRun: 10, maxBackgroundAgents: 1 },
            timezone: "Europe/Rome",
            scheduler,
            background: new BackgroundAgents(
                async () => "",
                async () => {},
                1,
            ),
            tracer,
        });
        await orchestrator.send("+393331234567", "any reminders?", { say: async () => {} });
        expect(started).toMatchObject([{ name: "message", userId: "+393331234567", input: "any reminders?" }]);
        expect(events).toEqual(["turn", "reminders_list_reminders", "turn", "chat_send_message", "turn"]);
        expect(ended).toMatchObject([{ status: "completed" }]);
        scheduler.stopAll();
    });

    it("sends Langfuse a trace with a hashed user, the turns with tokens, and the tools", async () => {
        const bodies: Buffer[] = [];
        const paths: string[] = [];
        const server = createServer((request, response) => {
            paths.push(request.url ?? "");
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
                bodies.push(Buffer.concat(chunks));
                response.writeHead(200, { "content-type": "application/json" }).end("{}");
            });
        });
        await new Promise<void>((resolve) => server.listen(0, resolve));
        const { port } = server.address() as AddressInfo;
        const tracer = createLangfuseTracer({
            publicKey: "pk-lf-test",
            secretKey: "sk-lf-test",
            baseUrl: `http://127.0.0.1:${port}`,
            content: true,
        });
        const trace = tracer.start({ name: "message", userId: "+393331234567", input: "hi", model: "claude" });
        trace.event({ type: "turn_start" });
        trace.event({
            type: "message_end",
            message: {
                role: "assistant",
                content: [{ type: "toolCall", id: "t1", name: "browser_download", arguments: { ref: "e1" } }],
                api: "anthropic-messages",
                provider: "anthropic",
                model: "claude-sonnet-5",
                usage: {
                    input: 1200,
                    output: 40,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 1240,
                    cost: { input: 0.003, output: 0.0006, cacheRead: 0, cacheWrite: 0, total: 0.0036 },
                },
                stopReason: "toolUse",
                timestamp: Date.now(),
            },
        });
        trace.event({
            type: "tool_execution_start",
            toolCallId: "t1",
            toolName: "browser_download",
            args: { ref: "e1" },
        });
        trace.event({
            type: "tool_execution_end",
            toolCallId: "t1",
            toolName: "browser_download",
            result: { content: [{ type: "text", text: "The file could not be read." }] },
            isError: true,
        });
        trace.end({ status: "completed", text: "" });
        await tracer.flush();
        server.close();
        // The exporter sends gzipped OTLP; names and attributes are plain inside.
        const sent = bodies
            .map((body) => (body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body).toString("latin1"))
            .join("\n");
        expect(paths.some((path) => path.includes("/api/public/otel"))).toBe(true);
        expect(sent).toContain("browser_download");
        expect(sent).toContain("turn 1");
        expect(sent).toContain(userHash("+393331234567"));
        expect(sent).not.toContain("+393331234567");
    });
});
