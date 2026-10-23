import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Cron } from "croner";

export interface Reminder {
    id: string;
    userId: string;
    /** What Conscious says when it fires, written as the message itself. For a check: its title. */
    text: string;
    /**
     * Set for a scheduled check: instead of sending `text`, an agent does this job when it fires
     * and messages the user only if it finds something worth telling.
     */
    check?: string;
    /**
     * Conscious set this up on its own, not because the user asked: a birthday nudge, a follow-up.
     * It waits out quiet hours and counts toward the daily limit (see `Pacing`).
     */
    unprompted?: boolean;
    /** A one-off reminder fires once at `at`; a recurring one follows `cron` in the user's timezone. */
    at?: Date;
    cron?: string;
    timezone: string;
    createdAt: Date;
}

export type NewReminder = Omit<Reminder, "id" | "createdAt">;
/** `late` is set when a one-off was due while Conscious was not running. */
export type Fire = (reminder: Reminder, late: boolean) => Promise<void>;

export interface SchedulerOptions {
    /** Where reminders are saved, so a restart keeps them. Without it they live in this process only. */
    file?: string;
}

// Past this, a one-off missed while Conscious was down is old news and is dropped, not sent.
const MAX_LATE_MS = 12 * 60 * 60_000;

type Saved = Omit<Reminder, "at" | "createdAt"> & { at?: string; createdAt: string };

/**
 * Reminders and scheduled checks. Saved after every change; `start` arms the saved ones and
 * sends one-offs that came due while Conscious was down, so call it once the channel can deliver.
 */
export class Scheduler {
    private readonly reminders = new Map<string, { reminder: Reminder; job?: Cron }>();
    private started = false;

    constructor(
        private readonly fire: Fire,
        private readonly options: SchedulerOptions = {},
    ) {
        if (options.file && existsSync(options.file)) {
            for (const saved of JSON.parse(readFileSync(options.file, "utf8")) as Saved[]) {
                const reminder: Reminder = {
                    ...saved,
                    at: saved.at ? new Date(saved.at) : undefined,
                    createdAt: new Date(saved.createdAt),
                };
                this.reminders.set(reminder.id, { reminder });
            }
        }
    }

    start(now = new Date()): void {
        if (this.started) return;
        this.started = true;
        for (const [id, entry] of this.reminders) {
            const { reminder } = entry;
            if (reminder.at && reminder.at <= now) {
                this.reminders.delete(id);
                if (now.getTime() - reminder.at.getTime() <= MAX_LATE_MS) this.run(reminder, true);
                continue;
            }
            entry.job = this.arm(reminder);
        }
        this.persist();
    }

    add(input: NewReminder): Reminder {
        if (!input.at === !input.cron) throw new Error("A reminder needs exactly one of `at` or `cron`");
        if (input.at && input.at.getTime() <= Date.now()) throw new Error("That time has already passed");
        const reminder: Reminder = { ...input, id: randomUUID().slice(0, 8), createdAt: new Date() };
        const job = this.arm(reminder);
        if (!job.nextRun()) {
            job.stop();
            throw new Error("That schedule never fires");
        }
        this.reminders.set(reminder.id, { reminder, job });
        this.persist();
        return reminder;
    }

    list(userId: string): (Reminder & { nextRun: Date | null })[] {
        return [...this.reminders.values()]
            .filter(({ reminder }) => reminder.userId === userId)
            .map(({ reminder, job }) => ({ ...reminder, nextRun: job?.nextRun() ?? reminder.at ?? null }));
    }

    /** Only the owner can cancel: an id from another user reads as missing. */
    cancel(userId: string, id: string): boolean {
        const entry = this.reminders.get(id);
        if (!entry || entry.reminder.userId !== userId) return false;
        entry.job?.stop();
        this.reminders.delete(id);
        this.persist();
        return true;
    }

    /** Stops the timers. Saved reminders stay saved for the next start. */
    stopAll(): void {
        for (const { job } of this.reminders.values()) job?.stop();
        this.reminders.clear();
    }

    private arm(reminder: Reminder): Cron {
        return new Cron(reminder.at ?? (reminder.cron as string), { timezone: reminder.timezone }, () => {
            if (reminder.at) {
                this.reminders.delete(reminder.id);
                this.persist();
            }
            this.run(reminder, false);
        });
    }

    private run(reminder: Reminder, late: boolean): void {
        void this.fire(reminder, late).catch((error) => console.error(`[scheduler] ${reminder.id} failed`, error));
    }

    private persist(): void {
        const { file } = this.options;
        if (!file) return;
        const saved: Saved[] = [...this.reminders.values()].map(({ reminder }) => ({
            ...reminder,
            at: reminder.at?.toISOString(),
            createdAt: reminder.createdAt.toISOString(),
        }));
        mkdirSync(dirname(file), { recursive: true });
        const temporary = `${file}.tmp`;
        writeFileSync(temporary, JSON.stringify(saved, null, 2));
        renameSync(temporary, file);
    }
}
