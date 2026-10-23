import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        agents.spawn("u1", { title: "Find a dentist", brief: "near Milan centre" });
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
        const task = agents.spawn("u1", { title: "a", brief: "b" });
        expect(() => agents.spawn("u1", { title: "c", brief: "d" })).toThrow();
        expect(agents.cancel("u2", task.id)).toBe(false);
        expect(agents.cancel("u1", task.id)).toBe(true);
        expect(agents.running("u1")).toHaveLength(0);
    });

    it("stops a task that runs past its effort's time and tells the user", async () => {
        vi.useFakeTimers();
        try {
            const sent: string[] = [];
            const agents = new BackgroundAgents(
                (_task, signal) =>
                    new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
                async (_userId, text) => {
                    sent.push(text);
                },
                1,
            );
            agents.spawn("u1", { title: "Plan the trip", brief: "b", effort: "quick" });
            await vi.advanceTimersByTimeAsync(12 * 60_000);
            expect(agents.running("u1")).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(2 * 60_000);
            expect(sent).toEqual(['I couldn\'t finish "Plan the trip": it ran out of time']);
        } finally {
            vi.useRealTimers();
        }
    });

    it("starts an interrupted task over after a restart, once", async () => {
        const file = join(mkdtempSync(join(tmpdir(), "background-")), "background.json");
        const never = () => new Promise<string>(() => {});
        const first = new BackgroundAgents(never, async () => {}, 2, file);
        const task = first.spawn("u1", { title: "Find a ticket", brief: "Lisbon" });
        first.message("u1", task.id, "only mornings");

        const briefs: string[] = [];
        const sent: string[] = [];
        const second = new BackgroundAgents(
            async (resumed) => {
                briefs.push(`${resumed.brief} / ${resumed.messages.join()} / ${resumed.restarts}`);
                return "TAP, 7:05";
            },
            async (_userId, text) => {
                sent.push(text);
            },
            2,
            file,
        );
        second.resume();
        await vi.waitFor(() => expect(sent).toEqual(["TAP, 7:05"]));
        expect(briefs).toEqual(["Lisbon / only mornings / 1"]);

        const again = new BackgroundAgents(never, async () => {}, 2, file);
        const interrupted = again.spawn("u1", { title: "Plan", brief: "b" });
        const third = new BackgroundAgents(never, async () => {}, 2, file);
        third.resume();
        const fourthSent: string[] = [];
        const fourth = new BackgroundAgents(
            never,
            async (_userId, text) => {
                fourthSent.push(text);
            },
            2,
            file,
        );
        fourth.resume();
        await vi.waitFor(() => expect(fourthSent).toHaveLength(1));
        expect(fourthSent[0]).toContain('couldn\'t finish "Plan"');
        expect(fourth.list("u1").find((saved) => saved.id === interrupted.id)?.status).toBe("failed");
    });
});
