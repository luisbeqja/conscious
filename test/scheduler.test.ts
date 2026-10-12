import { afterEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../src/scheduler/scheduler.js";

describe("Scheduler", () => {
    const fired: string[] = [];
    const scheduler = new Scheduler(async (reminder) => {
        fired.push(reminder.text);
    });
    afterEach(() => scheduler.stopAll());

    it("fires a one-off reminder once, then forgets it", async () => {
        scheduler.add({ userId: "u1", text: "drink water", at: new Date(Date.now() + 1100), timezone: "Europe/Rome" });
        expect(scheduler.list("u1")).toHaveLength(1);
        await vi.waitFor(() => expect(fired).toContain("drink water"), { timeout: 3000 });
        expect(scheduler.list("u1")).toHaveLength(0);
    });

    it("refuses a time in the past and a reminder with both or neither schedule", () => {
        const base = { userId: "u1", text: "x", timezone: "Europe/Rome" };
        expect(() => scheduler.add({ ...base, at: new Date(Date.now() - 1000) })).toThrow();
        expect(() => scheduler.add(base)).toThrow();
        expect(() => scheduler.add({ ...base, at: new Date(Date.now() + 60_000), cron: "0 8 * * *" })).toThrow();
    });

    it("keeps each user's reminders to themselves", () => {
        const reminder = scheduler.add({ userId: "u1", text: "x", cron: "0 8 * * *", timezone: "Europe/Rome" });
        expect(scheduler.list("u2")).toEqual([]);
        expect(scheduler.cancel("u2", reminder.id)).toBe(false);
        expect(scheduler.cancel("u1", reminder.id)).toBe(true);
    });
});
