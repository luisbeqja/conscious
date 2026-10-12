import { randomUUID } from "node:crypto";
import { Cron } from "croner";

export interface Reminder {
    id: string;
    userId: string;
    /** What Conscious says when it fires, written as the message itself. */
    text: string;
    /** A one-off reminder fires once at `at`; a recurring one follows `cron` in the user's timezone. */
    at?: Date;
    cron?: string;
    timezone: string;
    createdAt: Date;
}

export type NewReminder = Omit<Reminder, "id" | "createdAt">;
export type Fire = (reminder: Reminder) => Promise<void>;

/**
 * Reminders live in this process: a restart forgets them. A durable store that re-arms its
 * reminders on boot is the next step, and only this class has to change for it.
 */
export class Scheduler {
    private readonly reminders = new Map<string, { reminder: Reminder; job: Cron }>();

    constructor(private readonly fire: Fire) {}

    add(input: NewReminder): Reminder {
        if (!input.at === !input.cron) throw new Error("A reminder needs exactly one of `at` or `cron`");
        if (input.at && input.at.getTime() <= Date.now()) throw new Error("That time has already passed");
        const reminder: Reminder = { ...input, id: randomUUID().slice(0, 8), createdAt: new Date() };
        const job = new Cron(input.at ?? (input.cron as string), { timezone: input.timezone }, async () => {
            if (input.at) this.reminders.delete(reminder.id);
            await this.fire(reminder).catch((error) => console.error(`[scheduler] ${reminder.id} failed`, error));
        });
        if (!job.nextRun()) {
            job.stop();
            throw new Error("That schedule never fires");
        }
        this.reminders.set(reminder.id, { reminder, job });
        return reminder;
    }

    list(userId: string): (Reminder & { nextRun: Date | null })[] {
        return [...this.reminders.values()]
            .filter(({ reminder }) => reminder.userId === userId)
            .map(({ reminder, job }) => ({ ...reminder, nextRun: job.nextRun() }));
    }

    /** Only the owner can cancel: an id from another user reads as missing. */
    cancel(userId: string, id: string): boolean {
        const entry = this.reminders.get(id);
        if (!entry || entry.reminder.userId !== userId) return false;
        entry.job.stop();
        this.reminders.delete(id);
        return true;
    }

    stopAll(): void {
        for (const { job } of this.reminders.values()) job.stop();
        this.reminders.clear();
    }
}
