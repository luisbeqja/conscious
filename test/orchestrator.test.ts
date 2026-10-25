import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundAgents } from "../src/agents/background-agents.js";
import { createRegistry } from "../src/capabilities/index.js";
import { InMemoryConversationStore } from "../src/conversations/store.js";
import type { ModelRuntime } from "../src/engine/models.js";
import { Orchestrator, SentLog } from "../src/engine/orchestrator.js";
import type { RunProgress } from "../src/engine/run-agent.js";
import { Scheduler } from "../src/scheduler/scheduler.js";

/** The model sending the user a message, then stopping. */
const sends = (text: string) => [
    fauxAssistantMessage(fauxToolCall("chat_send_message", { text }), { stopReason: "toolUse" }),
    fauxAssistantMessage([]),
];

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
            ...sends("Done, I'll remind you in an hour."),
            ...sends("You asked me to remind you to call mum."),
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
        const said: string[] = [];
        const reply = await orchestrator.send("me", "remind me to call mum in an hour", {
            say: async (text) => void said.push(text),
            onProgress: (p) => progress.push(p),
        });

        expect(reply).toEqual(["Done, I'll remind you in an hour."]);
        expect(said).toEqual(reply);
        expect(scheduler.list("me").map((reminder) => reminder.text)).toEqual(["Call mum 📞"]);
        expect(progress).toContainEqual({ type: "tool", name: "reminders_create_reminder" });
        // The message shows as it is written; sending it is not a step of the work.
        expect(progress.flatMap((p) => (p.type === "text" ? [p.delta] : [])).join("")).toBe(said[0]);
        expect(progress).not.toContainEqual({ type: "tool", name: "chat_send_message" });

        await orchestrator.send("me", "what did I ask?");
        expect((await store.load("me")).filter((message) => message.role === "user")).toHaveLength(2);
    });

    it("lets the reaction model put an emoji on the message, and a reaction alone is a whole answer", async () => {
        const { faux, runtime } = scriptedModel();
        // The agent answers the first message and ends the second without a word.
        faux.setResponses([...sends("Anytime!"), fauxAssistantMessage([])]);
        const seen: string[] = [];
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
            reactor: {
                choose: async (recentChat) => {
                    seen.push(recentChat);
                    return recentChat.endsWith("thanks again") ? "❤️" : undefined;
                },
            },
        });
        const reactions: string[] = [];
        const react = async (emoji: string) => {
            reactions.push(emoji);
            return true;
        };

        expect(await orchestrator.send("me", "thanks", { react })).toEqual(["Anytime!"]);
        // The reaction landed, so ending without a word is the answer, and the agent is not asked for more.
        expect(await orchestrator.send("me", "thanks again", { react })).toEqual([]);
        expect(reactions).toEqual(["❤️"]);
        // The reaction model reads the chat so far, ending with the message it reacts to.
        expect(seen.at(-1)).toBe("User: thanks\nYou: Anytime!\nUser: thanks again");
        // The agent itself has no reaction tool any more.
        expect((await createRegistry().available("me")).map((capability) => capability.id)).not.toContain("reactions");
    });

    it("still asks for words when the agent did something, even after a reaction landed", async () => {
        const { faux, runtime } = scriptedModel();
        const at = new Date(Date.now() + 86_400_000).toISOString();
        let reminder = "";
        faux.setResponses([
            fauxAssistantMessage(fauxToolCall("reminders_create_reminder", { text: "Find a place in Tenerife", at }), {
                stopReason: "toolUse",
            }),
            // It sets the reminder, then would end without telling the user.
            fauxAssistantMessage([]),
            (context) => {
                reminder = JSON.stringify(context.messages.at(-1));
                return sends("Done, I'll remind you tomorrow 🏝️")[0] as ReturnType<typeof fauxAssistantMessage>;
            },
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
            reactor: { choose: async () => "👍" },
        });
        const reactions: string[] = [];

        const sent = await orchestrator.send("me", "remind me tomorrow to find a place in Tenerife", {
            react: async (emoji) => {
                reactions.push(emoji);
                return true;
            },
        });

        expect(reactions).toEqual(["👍"]);
        expect(sent).toEqual(["Done, I'll remind you tomorrow 🏝️"]);
        expect(reminder).toContain("You did something for them");
    });

    it("keeps what the agent writes outside a message to itself, and reminds it once when it sent nothing", async () => {
        const { faux, runtime } = scriptedModel();
        let reminded = "";
        faux.setResponses([
            fauxAssistantMessage(fauxText("Thursday at 9 works for the dentist.")),
            (context) => {
                reminded = JSON.stringify(context.messages.at(-1));
                return fauxAssistantMessage(fauxToolCall("chat_send_message", { text: "Thursday 9:00 works 🦷" }), {
                    stopReason: "toolUse",
                });
            },
            fauxAssistantMessage(fauxText("Sent it.")),
            fauxAssistantMessage(fauxText("They probably need nothing back.")),
            fauxAssistantMessage(fauxText("Still nothing to add.")),
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
        const said: string[] = [];
        const progress: RunProgress[] = [];
        const options = {
            say: async (text: string) => void said.push(text),
            onProgress: (p: RunProgress) => progress.push(p),
        };

        expect(await orchestrator.send("me", "is Thursday ok for the dentist?", options)).toEqual([
            "Thursday 9:00 works 🦷",
        ]);
        // The reminder quotes what it wrote, so it cannot take that for an answer that went out.
        expect(reminded).toContain('Not delivered: the user did not see \\"Thursday at 9 works for the dentist.\\"');
        // After the one reminder, silence is the agent's choice: no second reminder, and no fallback.
        expect(await orchestrator.send("me", "ok", options)).toEqual([]);
        expect(said).toEqual(["Thursday 9:00 works 🦷"]);
        // Kept: what the user said and what they were sent. The text nobody saw, and the reminder, are gone.
        const saved = JSON.stringify(await store.load("me"));
        expect(saved).toContain("Thursday 9:00 works 🦷");
        for (const unseen of ["works for the dentist", "Sent it.", "Not delivered", "nothing back", "nothing to add"]) {
            expect(saved).not.toContain(unseen);
        }
        expect(progress.flatMap((p) => (p.type === "text" ? [p.delta] : [])).join("")).toBe("Thursday 9:00 works 🦷");
    });

    it("sends the messages of one turn in the order they were written, and only so many", async () => {
        const { faux, runtime } = scriptedModel();
        const calls = ["one", "two", "three", "four", "five", "six"].map((text) =>
            fauxToolCall("chat_send_message", { text }),
        );
        faux.setResponses([fauxAssistantMessage(calls, { stopReason: "toolUse" }), fauxAssistantMessage([])]);
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
        const said: string[] = [];
        await orchestrator.send("me", "tell me five things", {
            say: async (text) => {
                // The first is the slowest to go out, and still arrives first.
                if (text === "one") await new Promise((resolve) => setTimeout(resolve, 20));
                said.push(text);
            },
        });
        expect(said).toEqual(["one", "two", "three", "four", "five"]);
    });

    it("says something broke when the answer failed before anything was sent", async () => {
        const { faux, runtime } = scriptedModel();
        faux.setResponses([]);
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
        const said: string[] = [];
        const reply = await orchestrator.send("me", "hi", { say: async (text) => void said.push(text) });
        expect(said).toEqual(reply);
        expect(reply[0]).toMatch(/something broke/);
    });

    it("tells the next answer what Conscious said on its own, once", async () => {
        const { faux, runtime } = scriptedModel();
        faux.setResponses([...sends("Great."), ...sends("Sure.")]);
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
        faux.setResponses(sends("Lisbon is down to 98 EUR on 3 Nov ✈️"));
        const said: string[] = [];
        const sent = await orchestratorWith(runtime).runCheck(reminder, async (text) => void said.push(text));
        expect(sent).toEqual(["Lisbon is down to 98 EUR on 3 Nov ✈️"]);
        expect(said).toEqual(sent);
    });

    it("stays quiet when the check found nothing", async () => {
        const { faux, runtime } = scriptedModel();
        // Nothing worth a message: it ends without sending, and is not asked to.
        faux.setResponses([fauxAssistantMessage(fauxText("Still 131 EUR, nothing to tell."))]);
        const said: string[] = [];
        expect(await orchestratorWith(runtime).runCheck(reminder, async (text) => void said.push(text))).toEqual([]);
        expect(said).toEqual([]);
    });
});

describe("Messages with files", () => {
    const scheduler = new Scheduler(async () => {});

    it("tells the agent what came in, and saves the conversation without the photo", async () => {
        const { faux, runtime } = scriptedModel();
        faux.setResponses(sends("Milk and eggs, got it."));
        const store = new InMemoryConversationStore();
        const orchestrator = new Orchestrator({
            registry: createRegistry(),
            store,
            runtime: { ...runtime, model: { ...runtime.model, input: ["text", "image"] } },
            budgets: { maxTurnsPerRun: 10, maxToolCallsPerRun: 10, maxBackgroundAgents: 1 },
            timezone: "Europe/Rome",
            scheduler,
            background: new BackgroundAgents(
                async () => "",
                async () => {},
                1,
            ),
        });
        await orchestrator.send("me", "", {
            files: [
                { name: "list.csv", mimeType: "text/csv", data: new TextEncoder().encode("milk,eggs") },
                { name: "fridge.png", mimeType: "image/png", data: new Uint8Array([137, 80, 78, 71]) },
            ],
        });
        const saved = JSON.stringify(await store.load("me"));
        expect(saved).toContain("milk,eggs");
        expect(saved).toContain("fridge.png (image/png");
        expect(saved).toContain("[a photo the user sent]");
        expect(saved).not.toContain("iVBORw");
    });
});
