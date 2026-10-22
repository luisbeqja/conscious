import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundAgents } from "../src/agents/background-agents.js";
import { createRegistry } from "../src/capabilities/index.js";
import { InMemoryConversationStore } from "../src/conversations/store.js";
import type { ModelRuntime } from "../src/engine/models.js";
import { Orchestrator, SentLog } from "../src/engine/orchestrator.js";
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
        const reply = await orchestrator.send("me", "remind me to call mum in an hour", {
            onProgress: (p) => progress.push(p),
        });

        expect(reply).toBe("Done, I'll remind you in an hour.");
        expect(scheduler.list("me").map((reminder) => reminder.text)).toEqual(["Call mum 📞"]);
        expect(progress).toContainEqual({ type: "tool", name: "reminders_create_reminder" });
        expect(progress.some((p) => p.type === "text")).toBe(true);

        await orchestrator.send("me", "what did I ask?");
        expect((await store.load("me")).filter((message) => message.role === "user")).toHaveLength(2);
    });

    it("reacts to the message, and a reaction alone is a whole answer", async () => {
        const { faux, runtime } = scriptedModel();
        faux.setResponses([
            fauxAssistantMessage(fauxText("Anytime!")),
            fauxAssistantMessage(fauxToolCall("reactions_react_message", { emoji: "❤️" }), { stopReason: "toolUse" }),
            fauxAssistantMessage([]),
        ]);
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
        });
        const reactions: string[] = [];
        const react = async (emoji: string) => {
            reactions.push(emoji);
            return true;
        };

        expect(await orchestrator.send("me", "thanks", { react })).toBe("Anytime!");
        // The earlier "Anytime!" must not be sent again for a message answered with a reaction.
        expect(await orchestrator.send("me", "thanks again", { react })).toBe("");
        expect(reactions).toEqual(["❤️"]);
    });

    it("tells the next answer what Conscious said on its own, once", async () => {
        const { faux, runtime } = scriptedModel();
        faux.setResponses([fauxAssistantMessage(fauxText("Great.")), fauxAssistantMessage(fauxText("Sure."))]);
        const store = new InMemoryConversationStore();
        const sent = new SentLog();
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
            sent,
        });
        sent.record("me", "GitHub is connected ✅");
        await orchestrator.send("me", "i did");
        await orchestrator.send("me", "thanks");
        const turns = (await store.load("me"))
            .filter((message) => message.role === "user")
            .map((message) => JSON.stringify(message.content));
        expect(turns[0]).toContain("You messaged the user on your own: GitHub is connected");
        expect(turns[1]).not.toContain("GitHub is connected");
    });
});

describe("Scheduled checks", () => {
    const scheduler = new Scheduler(async () => {});
    afterEach(() => scheduler.stopAll());

    const orchestratorWith = (runtime: ModelRuntime) =>
        new Orchestrator({
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
        });

    const reminder = {
        id: "c1",
        userId: "me",
        text: "Lisbon flight price",
        check: "Tell me only if MXP-LIS on 3 Nov is under 120 EUR.",
        cron: "0 9 * * *",
        timezone: "Europe/Rome",
        createdAt: new Date(),
    };

    it("sends what the check found", async () => {
        const { faux, runtime } = scriptedModel();
        faux.setResponses([fauxAssistantMessage(fauxText("Lisbon is down to 98 EUR on 3 Nov ✈️"))]);
        expect(await orchestratorWith(runtime).runCheck(reminder)).toBe("Lisbon is down to 98 EUR on 3 Nov ✈️");
    });

    it("stays quiet when the check found nothing", async () => {
        const { faux, runtime } = scriptedModel();
        faux.setResponses([fauxAssistantMessage(fauxText("NOTHING."))]);
        expect(await orchestratorWith(runtime).runCheck(reminder)).toBe("");
    });
});
