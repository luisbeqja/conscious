import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createModels,
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
    getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundAgents } from "../src/agents/background-agents.js";
import { createRegistry } from "../src/capabilities/index.js";
import { createMemoryCapability } from "../src/capabilities/memory/capability.js";
import type { ToolContext } from "../src/capabilities/types.js";
import { InMemoryConversationStore } from "../src/conversations/store.js";
import type { ModelRuntime } from "../src/engine/models.js";
import { Orchestrator } from "../src/engine/orchestrator.js";
import { FileMemoryStore, formatBirthday, InMemoryMemoryStore, renderMemory } from "../src/memory/memory.js";
import { Scheduler } from "../src/scheduler/scheduler.js";

describe("memory", () => {
    const scheduler = new Scheduler(async () => {});
    afterEach(() => scheduler.stopAll());
    const context: ToolContext = { userId: "me", timezone: "Europe/Rome", scheduler };

    const setup = () => {
        const store = new InMemoryMemoryStore();
        const capability = createMemoryCapability(store);
        const call = async (name: string, params: Record<string, unknown>) => {
            const tool = capability.tools.find((candidate) => candidate.name === name);
            if (!tool) throw new Error(name);
            return (await tool.execute(params, context)).data as Record<string, unknown>;
        };
        return { store, call };
    };

    it("remembers the user, the people in their life, and forgets on request", async () => {
        const { store, call } = setup();
        const fact = await call("memory_remember_fact", { text: "Lives in Milan" });
        const sister = await call("memory_save_person", { name: "Giulia", relation: "sister", birthday: "03-14" });
        await call("memory_remember_fact", { text: "Just moved to Berlin", person: "giulia" });
        const mum = await call("memory_remember_fact", { text: "Loves orchids", person: "Mum" });
        expect(await call("memory_save_person", { name: "GIULIA", birthday: "1994-03-14" })).toEqual(sister);

        const memory = await store.load("me");
        expect(memory.about.map((f) => f.text)).toEqual(["Lives in Milan"]);
        expect(memory.people.map((p) => [p.name, p.relation, p.birthday, p.notes.length])).toEqual([
            ["Giulia", "sister", "1994-03-14", 1],
            ["Mum", undefined, undefined, 1],
        ]);
        expect(renderMemory(memory)).toContain(`- Giulia, sister, birthday 14 Mar 1994 (#${sister.id})`);

        expect(await call("memory_forget", { id: `#${fact.id}` })).toEqual({ forgotten: true });
        expect(await call("memory_forget", { id: sister.id as string })).toEqual({ forgotten: true });
        expect(await call("memory_forget", { id: "nope" })).toEqual({ forgotten: false });
        const left = await store.load("me");
        expect(left.about).toEqual([]);
        expect(left.people.map((p) => p.name)).toEqual(["Mum"]);
        expect(mum.id).toBeDefined();
    });

    it("nudges a week before a birthday and on the day, and moves or drops the nudges with it", async () => {
        const { call } = setup();
        const crons = () => scheduler.list("me").map((reminder) => `${reminder.text}: ${reminder.cron}`);
        const giulia = await call("memory_save_person", { name: "Giulia", relation: "sister", birthday: "03-14" });
        expect(giulia.birthdayNudges).toBeDefined();
        expect(crons()).toEqual(["Giulia's birthday in a week: 0 18 7 3 *", "Giulia's birthday: 0 9 14 3 *"]);
        expect(scheduler.list("me")[1]?.check).toMatch(/sister/);

        await call("memory_save_person", { name: "Giulia", birthday: "01-03" });
        expect(crons()).toEqual(["Giulia's birthday in a week: 0 18 27 12 *", "Giulia's birthday: 0 9 3 1 *"]);

        await call("memory_save_person", { name: "Leap", birthday: "2000-02-29" });
        expect(crons()).toContain("Leap's birthday: 0 9 28 2 *");

        await call("memory_forget", { id: giulia.id });
        expect(crons().filter((line) => line.startsWith("Giulia"))).toEqual([]);
    });

    it("refuses a birthday that is not a date", async () => {
        const { call } = setup();
        expect(await call("memory_save_person", { name: "Leo", birthday: "02-30" })).toMatchObject({
            error: expect.stringMatching(/not a date/),
        });
        expect(formatBirthday("02-29")).toBe("29 Feb");
    });

    it("keeps memory on the host's disk across restarts, without phone numbers in file names", async () => {
        const dir = mkdtempSync(join(tmpdir(), "memory-"));
        await new FileMemoryStore(dir).save("+393331234567", {
            about: [{ id: "a1", text: "Runs on Sundays" }],
            people: [],
        });
        expect((await new FileMemoryStore(dir).load("+393331234567")).about[0]?.text).toBe("Runs on Sundays");
        expect((await new FileMemoryStore(dir).load("someone-else")).about).toEqual([]);
    });

    it("puts memory in every prompt, with no computer at all", async () => {
        const faux = fauxProvider();
        const models = createModels();
        models.setProvider(faux.provider);
        const runtime: ModelRuntime = {
            model: faux.getModel(),
            streamFn: (model, ctx, options) => models.streamSimple(model, ctx, options),
        };
        const prompts: string[] = [];
        faux.setResponses([
            (ctx) => {
                prompts.push(getCurrentSystemPrompt(ctx.messages) ?? "");
                return fauxAssistantMessage(fauxToolCall("memory_remember_fact", { text: "Goes by Lu" }), {
                    stopReason: "toolUse",
                });
            },
            fauxAssistantMessage(fauxText("Lu it is 😄")),
            (ctx) => {
                prompts.push(getCurrentSystemPrompt(ctx.messages) ?? "");
                return fauxAssistantMessage(fauxText("Hey Lu"));
            },
        ]);
        const memory = new InMemoryMemoryStore();
        const orchestrator = new Orchestrator({
            registry: createRegistry(undefined, [createMemoryCapability(memory)]),
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
            memory,
        });

        await orchestrator.send("me", "call me Lu");
        await orchestrator.send("me", "hi");
        expect(prompts[0]).toContain("# What you remember about the user\n\nNothing yet.");
        expect(prompts[0]).toContain("You have only just met");
        expect(prompts[1]).toMatch(/About them:\n- Goes by Lu \(#\w+\)/);
        expect(prompts[1]).not.toContain("You have only just met");
    });
});
