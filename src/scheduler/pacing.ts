import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Cron } from "croner";
import type { Reminder } from "./scheduler.js";

export interface PacingConfig {
    /** Local hours with no unprompted messages, from `start` to `end`. Unset means none. */
    quietHours?: { start: number; end: number };
    /** Unprompted messages a user gets in one day, at most. */
    maxUnpromptedPerDay: number;
}

/** What to do with a reminder that is due now. */
export type Pace = { action: "send" } | { action: "skip"; reason: string } | { action: "defer"; to: Date };

interface Saved {
    paused: Record<string, string>;
    sent: Record<string, { day: string; count: number }>;
}

/**
 * How often Conscious speaks first. A friend who texts too much is worse than one who never does,
 * so this is code, not prompt: messages Conscious decided to send on its own (birthdays,
 * follow-ups) wait out the night and stop at a daily limit, and a pause holds everything except
 * the reminders the user set themselves.
 */
export class Pacing {
    private readonly paused = new Map<string, Date>();
    private readonly sent = new Map<string, { day: string; count: number }>();

    constructor(
        private readonly config: PacingConfig,
        private readonly file?: string,
    ) {
        if (file && existsSync(file)) {
            const saved = JSON.parse(readFileSync(file, "utf8")) as Saved;
            for (const [userId, until] of Object.entries(saved.paused)) this.paused.set(userId, new Date(until));
            for (const [userId, sent] of Object.entries(saved.sent)) this.sent.set(userId, sent);
        }
    }

    pause(userId: string, until: Date): void {
        this.paused.set(userId, until);
        this.persist();
    }

    resume(userId: string): boolean {
        const was = this.paused.delete(userId);
        this.persist();
        return was;
    }

    pausedUntil(userId: string, now = new Date()): Date | undefined {
        const until = this.paused.get(userId);
        return until && until > now ? until : undefined;
    }

    decide(reminder: Reminder, now = new Date()): Pace {
        // A plain reminder the user set is a promise to them: it always goes.
        if (!reminder.check && !reminder.unprompted) return { action: "send" };
        const until = this.pausedUntil(reminder.userId, now);
        if (until) return { action: "skip", reason: `paused until ${until.toISOString()}` };
        if (!reminder.unprompted) return { action: "send" };
        const { quietHours } = this.config;
        if (quietHours && isQuiet(localHour(now, reminder.timezone), quietHours)) {
            const to = new Cron(`0 ${quietHours.end} * * *`, { timezone: reminder.timezone }).nextRun(now);
            if (to) return { action: "defer", to };
        }
        if (this.count(reminder.userId, reminder.timezone, now) >= this.config.maxUnpromptedPerDay) {
            return { action: "skip", reason: "the daily limit of unprompted messages is reached" };
        }
        return { action: "send" };
    }

    /** Counts a message sent on Conscious's own initiative. */
    record(reminder: Reminder, now = new Date()): void {
        if (!reminder.unprompted) return;
        const day = localDay(now, reminder.timezone);
        this.sent.set(reminder.userId, { day, count: this.count(reminder.userId, reminder.timezone, now) + 1 });
        this.persist();
    }

    private count(userId: string, timezone: string, now: Date): number {
        const sent = this.sent.get(userId);
        return sent?.day === localDay(now, timezone) ? sent.count : 0;
    }

    private persist(): void {
        if (!this.file) return;
        const saved: Saved = {
            paused: Object.fromEntries([...this.paused].map(([userId, until]) => [userId, until.toISOString()])),
            sent: Object.fromEntries(this.sent),
        };
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(`${this.file}.tmp`, JSON.stringify(saved, null, 2));
        renameSync(`${this.file}.tmp`, this.file);
    }
}

const localHour = (now: Date, timezone: string): number =>
    Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: timezone }).format(now));

const localDay = (now: Date, timezone: string): string =>
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);

/** Quiet hours may cross midnight: 22 to 8 is quiet at 23 and at 7. */
export const isQuiet = (hour: number, { start, end }: { start: number; end: number }): boolean =>
    start <= end ? hour >= start && hour < end : hour >= start || hour < end;

/** `22-8` → { start: 22, end: 8 }; `off` → undefined. */
export const parseQuietHours = (value: string): { start: number; end: number } | undefined => {
    if (value === "off") return undefined;
    const match = /^(\d{1,2})-(\d{1,2})$/.exec(value.trim());
    const [start, end] = match ? [Number(match[1]), Number(match[2])] : [];
    if (start === undefined || end === undefined || start > 23 || end > 23 || start === end) {
        throw new Error(`CONSCIOUS_QUIET_HOURS must look like 22-8 (from 22:00 to 08:00), or be "off", not "${value}"`);
    }
    return { start, end };
};
