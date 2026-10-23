import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isQuiet, Pacing, parseQuietHours } from "../src/scheduler/pacing.js";
import type { Reminder } from "../src/scheduler/scheduler.js";

const reminder = (fields: Partial<Reminder> = {}): Reminder => ({
    id: "r1",
    userId: "me",
    text: "Call mum 📞",
    timezone: "Europe/Rome",
    createdAt: new Date(),
    ...fields,
});
const nudge = reminder({ text: "Giulia's birthday", check: "…", unprompted: true });
// 15:00 and 23:30 in Rome (UTC+1 in November).
const afternoon = new Date("2026-11-10T14:00:00Z");
const night = new Date("2026-11-10T22:30:00Z");

describe("pacing", () => {
    it("holds what Conscious starts on its own until morning, never the user's own reminders", () => {
        const pacing = new Pacing({ quietHours: { start: 22, end: 8 }, maxUnpromptedPerDay: 3 });
        expect(pacing.decide(reminder(), night)).toEqual({ action: "send" });
        expect(pacing.decide(reminder({ check: "rain?" }), night)).toEqual({ action: "send" });
        expect(pacing.decide(nudge, night)).toEqual({ action: "defer", to: new Date("2026-11-11T07:00:00Z") });
        expect(pacing.decide(nudge, afternoon)).toEqual({ action: "send" });
    });

    it("stops at the daily limit, and starts counting again the next local day", () => {
        const pacing = new Pacing({ maxUnpromptedPerDay: 2 });
        pacing.record(nudge, afternoon);
        pacing.record(reminder(), afternoon);
        pacing.record(nudge, afternoon);
        expect(pacing.decide(nudge, afternoon)).toMatchObject({ action: "skip" });
        expect(pacing.decide(reminder(), afternoon)).toEqual({ action: "send" });
        expect(pacing.decide(nudge, new Date("2026-11-11T09:00:00Z"))).toEqual({ action: "send" });
    });

    it("pauses checks and nudges until a date, keeps that across a restart, and resumes", () => {
        const file = join(mkdtempSync(join(tmpdir(), "pacing-")), "pacing.json");
        new Pacing({ maxUnpromptedPerDay: 3 }, file).pause("me", new Date("2026-11-15T08:00:00Z"));
        const pacing = new Pacing({ maxUnpromptedPerDay: 3 }, file);
        expect(pacing.decide(nudge, afternoon)).toMatchObject({ action: "skip" });
        expect(pacing.decide(reminder({ check: "rain?" }), afternoon)).toMatchObject({ action: "skip" });
        expect(pacing.decide(reminder(), afternoon)).toEqual({ action: "send" });
        expect(pacing.decide(nudge, new Date("2026-11-16T10:00:00Z"))).toEqual({ action: "send" });
        expect(pacing.resume("me")).toBe(true);
        expect(pacing.decide(nudge, afternoon)).toEqual({ action: "send" });
    });

    it("reads quiet hours that cross midnight", () => {
        expect(parseQuietHours("22-8")).toEqual({ start: 22, end: 8 });
        expect(parseQuietHours("off")).toBeUndefined();
        expect(() => parseQuietHours("late")).toThrow(/22-8/);
        expect(isQuiet(23, { start: 22, end: 8 })).toBe(true);
        expect(isQuiet(7, { start: 22, end: 8 })).toBe(true);
        expect(isQuiet(8, { start: 22, end: 8 })).toBe(false);
        expect(isQuiet(14, { start: 13, end: 15 })).toBe(true);
    });
});
