import { describe, expect, it, vi } from "vitest";
import { BackgroundAgents } from "../src/agents/background-agents.js";

describe("BackgroundAgents", () => {
    it("messages the user when a task finishes and reports it to the orchestrator once", async () => {
        const sent: string[] = [];
        const agents = new BackgroundAgents(
            async (task) => `done: ${task.title}`,
            async (_userId, text) => {
                sent.push(text);
            },
            2,
        );
        agents.spawn("u1", "Find a dentist", "near Milan centre");
        await vi.waitFor(() => expect(sent).toEqual(["done: Find a dentist"]));
        expect(agents.takeUnreported("u1")).toHaveLength(1);
        expect(agents.takeUnreported("u1")).toHaveLength(0);
    });

    it("caps running tasks per user and lets only the owner cancel", async () => {
        const agents = new BackgroundAgents(
            (_task, signal) =>
                new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("x")))),
            async () => {},
            1,
        );
        const task = agents.spawn("u1", "a", "b");
        expect(() => agents.spawn("u1", "c", "d")).toThrow();
        expect(agents.cancel("u2", task.id)).toBe(false);
        expect(agents.cancel("u1", task.id)).toBe(true);
        expect(agents.running("u1")).toHaveLength(0);
    });
});
