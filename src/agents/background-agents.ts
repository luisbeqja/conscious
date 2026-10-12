import { randomUUID } from "node:crypto";

export type TaskStatus = "running" | "done" | "failed" | "cancelled";

export interface BackgroundTask {
    id: string;
    userId: string;
    title: string;
    brief: string;
    status: TaskStatus;
    startedAt: Date;
    finishedAt?: Date;
    result?: string;
    /** Has the orchestrator been told how it ended? It is, once, in the next message's context. */
    reported: boolean;
}

/** Does the job and returns what to tell the user. Runs a sub-agent with its own loop and tools. */
export type TaskRunner = (task: BackgroundTask, signal: AbortSignal) => Promise<string>;
export type Notify = (userId: string, text: string) => Promise<void>;

/**
 * Sub-agents that work while the conversation goes on. The orchestrator hands one a brief and
 * answers the user at once; the sub-agent messages the user itself when it is done.
 * Depth is one: a sub-agent's tools never include spawning another.
 */
export class BackgroundAgents {
    private readonly tasks = new Map<string, { task: BackgroundTask; controller: AbortController }>();

    constructor(
        private readonly runner: TaskRunner,
        private readonly notify: Notify,
        private readonly maxRunningPerUser: number,
    ) {}

    spawn(userId: string, title: string, brief: string): BackgroundTask {
        if (this.running(userId).length >= this.maxRunningPerUser) {
            throw new Error(`Already running ${this.maxRunningPerUser} tasks. Wait for one to finish or cancel one.`);
        }
        const task: BackgroundTask = {
            id: randomUUID().slice(0, 8),
            userId,
            title,
            brief,
            status: "running",
            startedAt: new Date(),
            reported: false,
        };
        const controller = new AbortController();
        this.tasks.set(task.id, { task, controller });
        void this.execute(task, controller.signal);
        return task;
    }

    list(userId: string): BackgroundTask[] {
        return [...this.tasks.values()].map(({ task }) => task).filter((task) => task.userId === userId);
    }

    running(userId: string): BackgroundTask[] {
        return this.list(userId).filter((task) => task.status === "running");
    }

    /** Finished tasks the orchestrator has not seen yet. Reading them marks them seen. */
    takeUnreported(userId: string): BackgroundTask[] {
        const finished = this.list(userId).filter((task) => task.status !== "running" && !task.reported);
        for (const task of finished) task.reported = true;
        return finished;
    }

    cancel(userId: string, id: string): boolean {
        const entry = this.tasks.get(id);
        if (!entry || entry.task.userId !== userId || entry.task.status !== "running") return false;
        entry.task.status = "cancelled";
        entry.task.finishedAt = new Date();
        entry.controller.abort();
        return true;
    }

    private async execute(task: BackgroundTask, signal: AbortSignal): Promise<void> {
        try {
            const result = await this.runner(task, signal);
            if (task.status === "cancelled") return;
            task.status = "done";
            task.result = result;
        } catch (error) {
            if (task.status === "cancelled") return;
            task.status = "failed";
            task.result = error instanceof Error ? error.message : String(error);
        }
        task.finishedAt = new Date();
        const text = task.status === "done" ? (task.result ?? "") : `I couldn't finish "${task.title}": ${task.result}`;
        await this.notify(task.userId, text).catch((error) =>
            console.error(`[background ${task.id}] notify failed`, error),
        );
    }
}
