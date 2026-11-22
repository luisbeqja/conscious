import { describe, expect, it } from "vitest";
import { BackgroundAgents } from "../src/agents/background-agents.js";
import { createRegistry } from "../src/capabilities/index.js";
import { conversationCommands } from "../src/conversations/commands.js";
import { InMemoryConversationStore } from "../src/conversations/store.js";
import { Orchestrator } from "../src/engine/orchestrator.js";
import { Scheduler } from "../src/scheduler/scheduler.js";

describe("/new", () => {
    it("starts a new conversation without the agent, and leaves other messages alone", async () => {
        const started: string[] = [];
        const command = conversationCommands({ newConversation: async (userId) => void started.push(userId) });
        expect(command("+393331234567", "/new")).toMatch(/New conversation/);
        expect(command("+393331234567", "/new@conscious_luisbot")).toMatch(/New conversation/);
        expect(command("+393331234567", "/nuova")).toMatch(/New conversation/);
        expect(command("+393331234567", "new")).toBeUndefined();
        expect(command("+393331234567", "/newsletter")).toBeUndefined();
        expect(command("+393331234567", "a new idea")).toBeUndefined();
        expect(started).toEqual(["+393331234567", "+393331234567", "+393331234567"]);
    });

    it("sets the conversation aside, after the answer in progress, and keeps the rest", async () => {
        const store = new InMemoryConversationStore();
        await store.save("me", [{ role: "user", content: "the old talk", timestamp: 1 }]);
        await store.save("you", [{ role: "user", content: "someone else's talk", timestamp: 1 }]);
        const scheduler = new Scheduler(async () => {});
        const orchestrator = new Orchestrator({
            registry: createRegistry(),
            store,
            runtime: { model: {} as never, streamFn: (() => {}) as never },
            budgets: { maxTurnsPerRun: 1, maxToolCallsPerRun: 1, maxBackgroundAgents: 1 },
            timezone: "Europe/Rome",
            scheduler,
            background: new BackgroundAgents(
                async () => "",
                async () => {},
                1,
            ),
        });
        await orchestrator.newConversation("me");
        expect(await store.load("me")).toEqual([]);
        expect(await store.load("you")).toHaveLength(1);
        scheduler.stopAll();
    });
});
