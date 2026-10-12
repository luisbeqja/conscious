import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundAgents } from "../src/agents/background-agents.js";
import { createRegistry } from "../src/capabilities/index.js";
import { InMemoryConversationStore } from "../src/conversations/store.js";
import type { ModelRuntime } from "../src/engine/models.js";
import { Orchestrator } from "../src/engine/orchestrator.js";
import type { RunProgress } from "../src/engine/run-agent.js";
import { Scheduler } from "../src/scheduler/scheduler.js";

const scriptedModel = () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime: ModelRuntime = {
        model: faux.getModel(),
        streamFn: (model, context, options) => models.streamSimple(model, context, options),
    };
    return { faux, runtime };
};

describe("Orchestrator", () => {
    const scheduler = new Scheduler(async () => {});
    afterEach(() => scheduler.stopAll());

    it("runs the real loop: calls a tool, answers, and remembers the conversation", async () => {
        const { faux, runtime } = scriptedModel();
        const at = new Date(Date.now() + 3_600_000).toISOString();
        faux.setResponses([
            fauxAssistantMessage(fauxToolCall("reminders_create_reminder", { text: "Call mum 📞", at }), {
                stopReason: "toolUse",
            }),
            fauxAssistantMessage(fauxText("Done, I'll remind you in an hour.")),
            fauxAssistantMessage(fauxText("You asked me to remind you to call mum.")),
        ]);
        const store = new InMemoryConversationStore();
        const orchestrator = new Orchestrator({
            registry: createRegistry(),
            store,
            runtime,
            budgets: { maxTurnsPerRun: 10, maxToolCallsPerRun: 10, maxBackgroundAgents: 1 },
            timezone: "Europe/Rome",
            scheduler,
            background: new BackgroundAgents(
                async () => "",
                async () => {},
                1,
            ),
        });

        const progress: RunProgress[] = [];
        const reply = await orchestrator.send("me", "remind me to call mum in an hour", (p) => progress.push(p));

        expect(reply).toBe("Done, I'll remind you in an hour.");
        expect(scheduler.list("me").map((reminder) => reminder.text)).toEqual(["Call mum 📞"]);
        expect(progress).toContainEqual({ type: "tool", name: "reminders_create_reminder" });
        expect(progress.some((p) => p.type === "text")).toBe(true);

        await orchestrator.send("me", "what did I ask?");
        expect((await store.load("me")).filter((message) => message.role === "user")).toHaveLength(2);
    });
});
