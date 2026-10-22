import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("Scheduler on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "conscious-scheduler-"));
    const file = join(dir, "reminders.json");

    it("keeps reminders and checks across a restart", () => {
        const first = new Scheduler(async () => {}, { file });
        first.add({ userId: "u1", text: "Stretch", cron: "0 8 * * *", timezone: "Europe/Rome" });
        first.add({
            userId: "u1",
            text: "Flight price",
            check: "Check MXP-LIS for 3 Nov; tell me only if under 120 EUR",
            at: new Date(Date.now() + 3_600_000),
            timezone: "Europe/Rome",
        });
        first.stopAll();

        const second = new Scheduler(async () => {}, { file });
        second.start();
        const listed = second.list("u1");
        expect(listed.map((reminder) => reminder.text).sort()).toEqual(["Flight price", "Stretch"]);
        expect(listed.find((reminder) => reminder.check)?.nextRun).toBeInstanceOf(Date);
        second.stopAll();
    });

    it("sends a one-off missed while it was down, marked late, and drops one that is too old", async () => {
        const fired: [string, boolean][] = [];
        const now = new Date();
        writeFileSync(
            file,
            JSON.stringify([
                {
                    id: "a",
                    userId: "u1",
                    text: "Missed by an hour",
                    at: new Date(now.getTime() - 3_600_000).toISOString(),
                    timezone: "UTC",
                    createdAt: now.toISOString(),
                },
                {
                    id: "b",
                    userId: "u1",
                    text: "Missed by two days",
                    at: new Date(now.getTime() - 48 * 3_600_000).toISOString(),
                    timezone: "UTC",
                    createdAt: now.toISOString(),
                },
            ]),
        );
        const scheduler = new Scheduler(
            async (reminder, late) => {
                fired.push([reminder.text, late]);
            },
            { file },
        );
        expect(fired).toEqual([]);
        scheduler.start(now);
        await vi.waitFor(() => expect(fired).toEqual([["Missed by an hour", true]]));
        expect(scheduler.list("u1")).toEqual([]);
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
        scheduler.stopAll();
    });
});
