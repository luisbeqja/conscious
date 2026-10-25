import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
    createModels,
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
    getCurrentSystemPrompt,
    getCurrentTools,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundAgents } from "../src/agents/background-agents.js";
import { AgentStore, dayIn, type NewAgent, renderAgentList } from "../src/agents/resting-agents.js";
import { createAgentsCapability } from "../src/capabilities/agents/capability.js";
import { createRegistry } from "../src/capabilities/index.js";
import { type Capability, defineTool } from "../src/capabilities/types.js";
import { InMemoryConversationStore } from "../src/conversations/store.js";
import type { ModelRuntime } from "../src/engine/models.js";
import { Orchestrator } from "../src/engine/orchestrator.js";
import { runAgent } from "../src/engine/run-agent.js";
import { adaptTool } from "../src/engine/tool-adapter.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { FakeSandboxes } from "./fake-sandbox.js";

const flights: NewAgent = {
    name: "flights",
    description: "Finds and compares flights for the user",
    capabilities: ["web", "kiwi"],
    method: "Compare the total price with bags.",
    created: "2026-10-23",
};

describe("AgentStore", () => {
    it("keeps an agent as files on the user's computer: its method, its notebook and a line per job", async () => {
        const sandboxes = new FakeSandboxes();
        const store = AgentStore.onComputer(sandboxes);
        await store.create("me", flights);
        await store.saveNotes("me", "flights", "- flies from MXP or BGY");
        await store.addNote("me", "flights", "Booked the second one: direct, 30 € more", "2026-10-24");
        await store.logRun("me", "flights", {
            date: "2026-10-23",
            taskId: "ab12cd34",
            title: "Flights to Lisbon",
            brief: "Lisbon, next week, carry-on only",
            status: "done",
            sent: ["TAP, €149 direct from MXP"],
            notes: "Ryanair was cheaper but no bag",
        });

        const sandbox = await sandboxes.forUser("me");
        expect(sandbox.files.get("/home/user/agents/flights/AGENT.md")).toContain("Compare the total price with bags.");
        expect(await store.notes("me", "flights")).toBe(
            "- flies from MXP or BGY\n- 2026-10-24, from the chat: Booked the second one: direct, 30 € more",
        );
        expect(await store.runs("me", "flights")).toEqual([
            "- 2026-10-23 · Flights to Lisbon · done · runs/2026-10-23-ab12cd34.md",
        ]);
        expect(sandbox.files.get("/home/user/agents/flights/runs/2026-10-23-ab12cd34.md")).toContain(
            "## Sent to the user\n\nTAP, €149 direct from MXP\n\n## Notes\n\nRyanair was cheaper but no bag",
        );
        const listed = await store.list("me");
        expect(listed).toEqual([{ ...flights, jobs: 1, last: "2026-10-23" }]);
        expect(renderAgentList(listed)).toBe(
            "- `flights`: Finds and compares flights for the user (1 job, last 2026-10-23)",
        );
    });

    it("lists the agent used most recently first", async () => {
        const store = AgentStore.onComputer(new FakeSandboxes());
        await store.create("me", flights);
        await store.create("me", {
            ...flights,
            name: "gift-ideas",
            description: "Finds presents",
            created: "2026-10-01",
        });
        await store.logRun("me", "gift-ideas", {
            date: "2026-11-02",
            taskId: "t1",
            title: "A present",
            brief: "b",
            status: "done",
            sent: [],
        });
        expect((await store.list("me")).map((agent) => agent.name)).toEqual(["gift-ideas", "flights"]);
        expect(renderAgentList([])).toBe("None yet.");
    });

    it("asks the agent to shorten a notebook that grew too long", async () => {
        const store = AgentStore.onComputer(new FakeSandboxes());
        await store.create("me", flights);
        await expect(store.saveNotes("me", "flights", "x".repeat(5_000))).rejects.toThrow(/under 4000/);
    });

    it("refuses a name that is not one plain folder", async () => {
        const store = AgentStore.onComputer(new FakeSandboxes());
        await expect(store.create("me", { ...flights, name: "../memory" })).rejects.toThrow(/lowercase/);
        expect(await store.load("me", "../memory")).toBeUndefined();
    });

    it("works without a computer, in a folder per user that does not show their number, and forgets", async () => {
        const dir = mkdtempSync(join(tmpdir(), "agents-"));
        const store = AgentStore.onHost(dir);
        await store.create("+393331234567", flights);
        await store.create("+393331234567", { ...flights, name: "gift-ideas" });
        expect(readdirSync(dir).join()).not.toContain("393331234567");
        expect(await store.list("someone-else")).toEqual([]);

        expect(await store.forget("+393331234567", "flights")).toBe(true);
        expect(await store.forget("+393331234567", "flights")).toBe(false);
        expect((await store.list("+393331234567")).map((agent) => agent.name)).toEqual(["gift-ideas"]);
        await store.forgetAll("+393331234567");
        expect(await store.list("+393331234567")).toEqual([]);
    });
});

describe("BackgroundAgents and agents", () => {
    it("gives an agent one job at a time", () => {
        const agents = new BackgroundAgents(
            () => new Promise<string>(() => {}),
            async () => {},
            5,
        );
        agents.spawn("me", { title: "Flights to Lisbon", brief: "b", agent: { name: "flights" } });
        expect(() => agents.spawn("me", { title: "Flights to Tokyo", brief: "b", agent: { name: "flights" } })).toThrow(
            /already working on "Flights to Lisbon"/,
        );
        expect(() =>
            agents.spawn("me", { title: "A present", brief: "b", agent: { name: "gift-ideas" } }),
        ).not.toThrow();
        expect(() => agents.spawn("you", { title: "Flights", brief: "b", agent: { name: "flights" } })).not.toThrow();
        expect(() => agents.spawn("me", { title: "Weather", brief: "b" })).not.toThrow();
    });
});

type Reply = (messages: readonly Message[]) => AssistantMessage | Promise<AssistantMessage>;

const text =
    (value: string): Reply =>
    () =>
        fauxAssistantMessage(fauxText(value));
const call =
    (name: string, args: Parameters<typeof fauxToolCall>[1]): Reply =>
    () =>
        fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
/** The model sending the user a message; `done` is the turn after it, which ends the run. */
const send = (value: string): Reply => call("chat_send_message", { text: value });
const done: Reply = () => fauxAssistantMessage([]);

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

describe("an agent across jobs", () => {
    const scheduler = new Scheduler(async () => {});
    afterEach(() => scheduler.stopAll());
    const timezone = "Europe/Rome";

    /** A scripted model for the chat and the background runs, recording what each run saw. */
    const setUp = (store: AgentStore) => {
        const faux = fauxProvider();
        const models = createModels();
        models.setProvider(faux.provider);
        const scripts = { main: [] as Reply[], background: [] as Reply[] };
        const prompts = { main: [] as string[], background: [] as string[] };
        const tools = { main: [] as string[][], background: [] as string[][] };
        faux.setResponses(
            Array.from({ length: 50 }, () => (context, options) => {
                const lane = options?.sessionId?.startsWith("background-") ? "background" : "main";
                prompts[lane].push(getCurrentSystemPrompt(context.messages));
                tools[lane].push(getCurrentTools(context.messages).map((tool) => tool.name));
                const next = scripts[lane].shift();
                if (!next) throw new Error(`no scripted ${lane} reply left`);
                return next(context.messages);
            }),
        );
        const runtime: ModelRuntime = {
            model: faux.getModel(),
            streamFn: (model, context, options) => models.streamSimple(model, context, options),
        };
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
            registry: createRegistry(undefined, [webCapability, createAgentsCapability(store)]),
            store: new InMemoryConversationStore(),
            runtime,
            budgets: { maxTurnsPerRun: 10, maxToolCallsPerRun: 10, maxBackgroundAgents: 3 },
            timezone,
            scheduler,
            background,
            agents: store,
        });
        return { scripts, prompts, tools, sent, background, orchestrator };
    };

    it("makes an agent for a new kind of job, keeps its notebook, and wakes it for the next one", async () => {
        const sandboxes = new FakeSandboxes();
        const store = AgentStore.onComputer(sandboxes);
        const { scripts, prompts, tools, sent, background, orchestrator } = setUp(store);
        const today = dayIn(timezone);

        // October: no agent yet, so the orchestrator designs one for flights.
        scripts.main.push(
            call("background_start_task", {
                title: "Flights to Lisbon",
                brief: "Find the best flight to Lisbon next week. Carry-on only.",
                agent: "flights",
                agentDescription: "Finds and compares flights for the user",
                instructions: "Compare the total price with bags. Check direct and one-stop.",
                capabilities: ["web"],
            }),
            send("On it, I'll text you the best ones."),
            done,
        );
        scripts.background.push(
            call("notebook_save_notes", { notes: "- flies from MXP or BGY\n- carry-on only" }),
            send("Two good ones: €119 with a stop, or €149 direct from MXP."),
            text("Easyjet had nothing direct."),
        );
        const [ack] = await orchestrator.send("me", "find me a flight to Lisbon next week");
        expect(ack).toContain("On it");
        await vi.waitFor(() => expect(background.running("me")).toHaveLength(0));
        expect(sent).toEqual(["Two good ones: €119 with a stop, or €149 direct from MXP."]);

        const first = prompts.background[0] ?? "";
        expect(first).toContain("# You are the user's flights agent");
        expect(first).toContain("This is your first job of this kind for them.");
        expect(first).toContain("## Your method\n\nCompare the total price with bags. Check direct and one-stop.");
        expect(first).toContain("## Your notebook\n\nEmpty so far.");
        expect(first).not.toContain("# How to do this job");
        expect(tools.background[0]).toEqual(expect.arrayContaining(["web_search_pages", "notebook_save_notes"]));
        expect(tools.background[0]).not.toContain("agents_add_note");
        expect(tools.background[0]).not.toContain("background_start_task");
        expect(await store.notes("me", "flights")).toBe("- flies from MXP or BGY\n- carry-on only");
        expect(await store.runs("me", "flights")).toEqual([
            expect.stringMatching(new RegExp(`^- ${today} · Flights to Lisbon · done · runs/${today}-\\w+\\.md$`)),
        ]);

        // The user tells Conscious what they picked: it goes into the agent's notebook.
        scripts.main.push(
            call("agents_add_note", { agent: "flights", note: "Booked the second one: direct, 30 € more" }),
            send("Nice ✈️"),
            done,
        );
        await orchestrator.send("me", "booked the second one!");
        expect(prompts.main.at(-2)).toContain(
            `# Your agents\n\nEach did background jobs of one kind before and kept a notebook.`,
        );
        expect(prompts.main.at(-2)).toContain(
            `- \`flights\`: Finds and compares flights for the user (1 job, last ${today})`,
        );
        expect(await store.notes("me", "flights")).toContain("from the chat: Booked the second one: direct, 30 € more");

        // November: the same kind of job wakes the same agent, with what it kept.
        scripts.main.push(
            call("background_start_task", {
                title: "Flights to Tokyo",
                brief: "A flight to Tokyo around 12 December.",
                agent: "flights",
            }),
            send("On it."),
            done,
        );
        scripts.background.push(send("Direct from MXP on 12 Dec, €612."), done);
        await orchestrator.send("me", "now a flight to Tokyo in December?");
        await vi.waitFor(() => expect(background.running("me")).toHaveLength(0));
        expect(sent).toHaveLength(2);

        const second = prompts.background.at(-1) ?? "";
        expect(second).toContain("You have done this kind of job for them 1 time");
        expect(second).toContain("- flies from MXP or BGY");
        expect(second).toContain("from the chat: Booked the second one");
        expect(second).toContain("## Your last jobs");
        expect(second).toContain("Flights to Lisbon · done");
        // It works with the tools it had; with no computer among them, its old answers are not offered as files.
        expect(tools.background.at(-1)).toContain("web_search_pages");
        expect(second).not.toContain("on your computer");
        expect(second).not.toContain("# How to do this job");
        expect((await store.list("me"))[0]).toMatchObject({ name: "flights", jobs: 2, last: today });
    });

    it("forgets every agent when the user starts fresh", async () => {
        const store = AgentStore.onHost(mkdtempSync(join(tmpdir(), "agents-")));
        await store.create("me", flights);
        const { orchestrator } = setUp(store);
        await orchestrator.startFresh("me");
        expect(await store.list("me")).toEqual([]);
    });
});

describe("an agent out of time", () => {
    it("can still save its notebook once its time is up, and nothing else", async () => {
        const faux = fauxProvider();
        const models = createModels();
        models.setProvider(faux.provider);
        const ran: string[] = [];
        const tool = (name: string) =>
            defineTool({
                name,
                label: name,
                description: name,
                effect: "draft",
                parameters: Type.Object({}),
                execute: async () => {
                    ran.push(name);
                    return { data: {} };
                },
            });
        const registered = [tool("web_search_pages"), tool("notebook_save_notes")];
        faux.setResponses([
            fauxAssistantMessage(fauxToolCall("web_search_pages", {}), { stopReason: "toolUse" }),
            fauxAssistantMessage(fauxToolCall("notebook_save_notes", {}), { stopReason: "toolUse" }),
            fauxAssistantMessage(fauxText("Here is what I found.")),
        ]);
        const scheduler = new Scheduler(async () => {});
        const context = { userId: "me", timezone: "Europe/Rome", scheduler };
        const result = await runAgent({
            runtime: {
                model: faux.getModel(),
                streamFn: (model, ctx, options) => models.streamSimple(model, ctx, options),
            },
            systemPrompt: "Find flights.",
            tools: registered.map((candidate) => adaptTool(candidate, context)),
            effects: new Map(registered.map((candidate) => [candidate.name, candidate.effect])),
            history: [],
            prompt: "Go.",
            budgets: { maxTurnsPerRun: 5, maxToolCallsPerRun: 5, maxBackgroundAgents: 1 },
            sessionId: "background-late",
            deadline: Date.now() - 1,
            lastWords: new Set(["notebook_save_notes"]),
        });
        expect(ran).toEqual(["notebook_save_notes"]);
        expect(result.text).toBe("Here is what I found.");
        scheduler.stopAll();
    });
});
