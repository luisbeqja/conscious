import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundAgents } from "../src/agents/background-agents.js";
import { createRegistry } from "../src/capabilities/index.js";
import { type Capability, defineTool } from "../src/capabilities/types.js";
import { InMemoryConversationStore } from "../src/conversations/store.js";
import type { ModelRuntime } from "../src/engine/models.js";
import { Orchestrator } from "../src/engine/orchestrator.js";
import { Scheduler } from "../src/scheduler/scheduler.js";

type Reply = (messages: readonly Message[]) => AssistantMessage | Promise<AssistantMessage>;

/**
 * A scripted model that answers the main chat and each background run from their own scripts,
 * so the two can interleave the way they do for real.
 */
const twoScripts = () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const scripts = { main: [] as Reply[], background: [] as Reply[] };
    const seen = { main: [] as string[], background: [] as string[] };
    faux.setResponses(
        Array.from({ length: 50 }, () => (context, options) => {
            const lane = options?.sessionId?.startsWith("background-") ? "background" : "main";
            seen[lane].push(JSON.stringify(context.messages));
            const next = scripts[lane].shift();
            if (!next) throw new Error(`no scripted ${lane} reply left`);
            return next(context.messages);
        }),
    );
    const runtime: ModelRuntime = {
        model: faux.getModel(),
        streamFn: (model, context, options) => models.streamSimple(model, context, options),
    };
    return { runtime, scripts, seen };
};

const text =
    (value: string): Reply =>
    () =>
        fauxAssistantMessage(fauxText(value));
const call =
    (name: string, args: Parameters<typeof fauxToolCall>[1]): Reply =>
    () =>
        fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

const webCapability: Capability = {
    id: "web",
    summary: "Search the web.",
    skill: "",
    tools: [
        defineTool({
            name: "web_search_pages",
            label: "Search the web",
            description: "Search the web.",
            effect: "read",
            parameters: Type.Object({ query: Type.String() }),
            execute: async () => ({ data: [] }),
        }),
    ],
};

describe("a background task while the chat goes on", () => {
    const scheduler = new Scheduler(async () => {});
    afterEach(() => scheduler.stopAll());

    const setUp = () => {
        const model = twoScripts();
        const sent: string[] = [];
        let orchestrator: Orchestrator | undefined;
        const background: BackgroundAgents = new BackgroundAgents(
            (task, signal) => (orchestrator as Orchestrator).runBackgroundTask(task, signal),
            async (_userId, message) => {
                sent.push(message);
            },
            3,
        );
        orchestrator = new Orchestrator({
            registry: createRegistry(undefined, [webCapability]),
            store: new InMemoryConversationStore(),
            runtime: model.runtime,
            budgets: { maxTurnsPerRun: 10, maxToolCallsPerRun: 10, maxBackgroundAgents: 3 },
            timezone: "Europe/Lisbon",
            scheduler,
            background,
        });
        return { ...model, sent, background, orchestrator };
    };

    it("answers other questions while the sub-agent works, then delivers its result", async () => {
        const { scripts, seen, sent, background, orchestrator } = setUp();
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        scripts.main.push(
            call("background_start_task", {
                title: "Find a ticket to Lisbon",
                brief: "Find the best flight to Lisbon for next week.",
                effort: "long",
            }),
            text("On it! I'll text you the best ticket as soon as I have it."),
            text("Sunny, 24°C most of next week."),
        );
        scripts.background.push(async () => {
            await held;
            return fauxAssistantMessage(fauxText("Found it: TAP on Tuesday, €89 return."));
        });

        const ack = await orchestrator.send("me", "can you find me a ticket for Lisbon?");
        expect(ack).toContain("On it");
        expect(background.running("me")).toHaveLength(1);

        expect(await orchestrator.send("me", "by the way, what's the weather in Lisbon next week?")).toContain("Sunny");
        expect(seen.main.at(-1)).toContain("Still running in the background");

        release();
        await vi.waitFor(() => expect(sent).toEqual(["Found it: TAP on Tuesday, €89 return."]));
        expect(seen.background[0]).toContain("can you find me a ticket for Lisbon?");
    });

    it("texts the user a first find while it keeps looking, and the chat knows about it", async () => {
        const { scripts, seen, sent, background, orchestrator } = setUp();
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        scripts.main.push(
            call("background_start_task", { title: "Find a ticket to Lisbon", brief: "Best flight to Lisbon." }),
            text("On it!"),
            text("Still checking Ryanair, the TAP one is the best so far."),
        );
        scripts.background.push(
            call("task_tell_user", { text: "First find: TAP, €89 return. Still checking the others." }),
            async () => {
                await held;
                return fauxAssistantMessage(fauxText("TAP stays the best: €89 return on Tuesday."));
            },
        );

        await orchestrator.send("me", "find me a ticket for Lisbon");
        await vi.waitFor(() => expect(sent).toEqual(["First find: TAP, €89 return. Still checking the others."]));
        expect(background.running("me")[0]?.steps).toBe(1);

        await orchestrator.send("me", "how is it going?");
        expect(seen.main.at(-1)).toContain("it already texted the user");

        release();
        await vi.waitFor(() => expect(sent).toHaveLength(2));
    });

    it("passes a change of plan to the running task", async () => {
        const { scripts, seen, sent, orchestrator } = setUp();
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        scripts.main.push(
            call("background_start_task", { title: "Find a ticket to Lisbon", brief: "Best flight to Lisbon." }),
            text("On it!"),
            (messages) => {
                const id = /\(([0-9a-f]{8})\)/.exec(JSON.stringify(messages.at(-1)))?.[1] ?? "";
                return fauxAssistantMessage(
                    fauxToolCall("background_message_task", { id, message: "Only morning flights." }),
                    { stopReason: "toolUse" },
                );
            },
            text("Got it, mornings only."),
        );
        scripts.background.push(async () => {
            await held;
            return fauxAssistantMessage(fauxToolCall("reminders_list_reminders", {}), { stopReason: "toolUse" });
        }, text("TAP at 7:05 on Tuesday, €95 return."));

        await orchestrator.send("me", "find me a ticket for Lisbon");
        expect(await orchestrator.send("me", "oh, only morning flights please")).toBe("Got it, mornings only.");
        release();
        await vi.waitFor(() => expect(sent).toEqual(["TAP at 7:05 on Tuesday, €95 return."]));
        expect(seen.background.at(-1)).toContain("Only morning flights.");
    });

    it("runs the sub-agent it designed: its method, its tools, and parts side by side", async () => {
        const { scripts, seen, sent, orchestrator } = setUp();
        scripts.main.push(
            call("background_start_task", {
                title: "Find a ticket to Lisbon",
                brief: "Cheapest return to Lisbon next week.",
                instructions: "Compare total price with one cabin bag. Prefer direct flights.",
                capabilities: ["web"],
                lanes: [
                    { title: "From Milan", brief: "Flights from Milan airports." },
                    { title: "From Bergamo", brief: "Flights from Bergamo." },
                ],
            }),
            text("On it, checking Milan and Bergamo at the same time."),
        );
        const part = (messages: readonly Message[]) => {
            const lane = JSON.stringify(messages).includes('Your part, \\"From Milan\\"') ? "Milan" : "Bergamo";
            return fauxAssistantMessage(fauxText(`${lane}: €${lane === "Milan" ? 120 : 89}`));
        };
        scripts.background.push(part, part, text("Bergamo wins: €89 return, direct."));

        await orchestrator.send("me", "find me a ticket for Lisbon");
        await vi.waitFor(() => expect(sent).toEqual(["Bergamo wins: €89 return, direct."]));

        const merge = seen.background.at(-1) ?? "";
        expect(merge).toContain("Milan: €120");
        expect(merge).toContain("Bergamo: €89");
        for (const run of seen.background) {
            expect(run).toContain("Compare total price with one cabin bag.");
            expect(run).toContain("web_search_pages");
            expect(run).not.toContain("reminders_create_reminder");
        }
    });
});
