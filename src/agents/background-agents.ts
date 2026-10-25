import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type TaskStatus = "running" | "done" | "failed" | "cancelled";

/** How long a job may take. The orchestrator picks it per task. */
export type Effort = "quick" | "long" | "deep";

export interface EffortBudget {
    maxTurns: number;
    maxToolCalls: number;
    /** After this the sub-agent must answer with what it has. */
    minutes: number;
}

export const EFFORT: Record<Effort, EffortBudget> = {
    quick: { maxTurns: 20, maxToolCalls: 40, minutes: 10 },
    long: { maxTurns: 60, maxToolCalls: 120, minutes: 30 },
    deep: { maxTurns: 120, maxToolCalls: 250, minutes: 60 },
};

/** Messages a sub-agent may send the user before its result, so a long job is not silent but never chatty. */
export const MAX_UPDATES = 3;

/** Parts of one job that run side by side, each in a sub-agent of its own. */
export const MAX_LANES = 5;

export interface Lane {
    title: string;
    brief: string;
    status?: "running" | "done" | "failed";
    /** What it found, for the sub-agent that puts the parts together. */
    result?: string;
}

/**
 * The sub-agent the orchestrator designs for one job: how it works, which capabilities it
 * gets, and whether the job splits into parts that run at once and are then put together.
 */
export interface Harness {
    /** Its method and what a good answer looks like, added to its system prompt. */
    instructions?: string;
    /** The capability ids it gets. All of them when empty. */
    capabilities?: string[];
    lanes?: Lane[];
}

/** The agent a job belongs to: one the user already has, or a new one made for it. */
export interface TaskAgent {
    name: string;
    /** For a new agent: one line on the kind of job it does. */
    description?: string;
}

// Time to write the final answer once the deadline has passed, before the run is stopped.
const GRACE_MS = 3 * 60_000;

export interface BackgroundTask {
    id: string;
    userId: string;
    title: string;
    brief: string;
    effort: Effort;
    harness: Harness;
    /** The agent doing the job, which keeps its notes once the job is done. None for a one-off. */
    agent?: TaskAgent;
    /** The last messages of the chat when the task started, so the sub-agent knows what led to it. */
    recentChat?: string;
    status: TaskStatus;
    startedAt: Date;
    finishedAt?: Date;
    result?: string;
    /** Tool calls made so far. */
    steps: number;
    /** The tool it called last, while it runs. */
    lastStep?: string;
    /** What the user added after it started, passed on by the orchestrator. */
    messages: string[];
    /** What it told the user while working, before its result. */
    updates: string[];
    /** How many times a restart of Conscious made it start over. */
    restarts: number;
    /** Has the orchestrator been told how it ended? It is, once, in the next message's context. */
    reported: boolean;
}

export interface NewTask {
    title: string;
    brief: string;
    effort?: Effort;
    harness?: Harness;
    agent?: TaskAgent;
    recentChat?: string;
}

/** Does the job and returns what to tell the user. Runs a sub-agent with its own loop and tools. */
export type TaskRunner = (task: BackgroundTask, signal: AbortSignal) => Promise<string>;
export type Notify = (userId: string, text: string) => Promise<void>;

// A finished task is kept this long, for the list and for the chat to refer back to.
const KEEP_FINISHED_MS = 7 * 24 * 60 * 60_000;

/** When a task must have answered: its effort's minutes after it started. */
export const deadlineOf = (task: BackgroundTask): number =>
    task.startedAt.getTime() + EFFORT[task.effort].minutes * 60_000;

/**
 * Sub-agents that work while the conversation goes on. The orchestrator hands one a brief and
 * answers the user at once; the sub-agent messages the user itself when it is done.
 * Depth is one: a sub-agent's tools never include spawning another.
 */
export class BackgroundAgents {
    private readonly tasks = new Map<string, { task: BackgroundTask; controller: AbortController }>();
    private readonly listeners = new Set<(userId: string) => void>();

    constructor(
        private readonly runner: TaskRunner,
        private readonly notify: Notify,
        private readonly maxRunningPerUser: number,
        /** Where tasks are saved, so a restart picks up the ones that were running. */
        private readonly file?: string,
    ) {
        if (!file || !existsSync(file)) return;
        const saved = JSON.parse(readFileSync(file, "utf8")) as BackgroundTask[];
        for (const task of saved) {
            task.startedAt = new Date(task.startedAt);
            task.finishedAt = task.finishedAt ? new Date(task.finishedAt) : undefined;
            if (task.finishedAt && Date.now() - task.finishedAt.getTime() > KEEP_FINISHED_MS) continue;
            this.tasks.set(task.id, { task, controller: new AbortController() });
        }
    }

    /**
     * Picks up the tasks a restart interrupted: each starts over once, knowing what it already
     * told the user. Call it once the channels can deliver messages.
     */
    resume(): void {
        for (const { task } of this.tasks.values()) {
            if (task.status !== "running") continue;
            if (task.restarts >= 1) {
                task.status = "failed";
                task.result = "I was restarted twice while working on it";
                task.finishedAt = new Date();
                void this.notify(task.userId, `I couldn't finish "${task.title}": ${task.result}. Ask me again?`).catch(
                    (error) => console.error(`[background ${task.id}] notify failed`, error),
                );
                continue;
            }
            task.restarts++;
            task.startedAt = new Date();
            task.steps = 0;
            task.lastStep = undefined;
            for (const lane of task.harness.lanes ?? []) {
                lane.status = undefined;
                lane.result = undefined;
            }
            const controller = new AbortController();
            this.tasks.set(task.id, { task, controller });
            void this.execute(task, controller);
        }
        this.save();
        for (const userId of new Set(this.list().map((task) => task.userId))) this.emit(userId);
    }

    /** Called with the user whose tasks changed: one started, took a step, or ended. */
    onChange(listener: (userId: string) => void): void {
        this.listeners.add(listener);
    }

    spawn(userId: string, request: NewTask): BackgroundTask {
        if (this.running(userId).length >= this.maxRunningPerUser) {
            throw new Error(`Already running ${this.maxRunningPerUser} tasks. Wait for one to finish or cancel one.`);
        }
        if ((request.harness?.lanes?.length ?? 0) > MAX_LANES) {
            throw new Error(`At most ${MAX_LANES} parts run at once. Merge some of them.`);
        }
        // An agent does one job at a time, so its notebook is never rewritten by two at once.
        const busy = request.agent && this.running(userId).find((task) => task.agent?.name === request.agent?.name);
        if (busy) {
            throw new Error(
                `The ${busy.agent?.name} agent is already working on "${busy.title}". Pass new details to that task with background_message_task, or wait until it is done.`,
            );
        }
        const task: BackgroundTask = {
            id: randomUUID().slice(0, 8),
            userId,
            title: request.title,
            brief: request.brief,
            effort: request.effort ?? "long",
            harness: {
                ...request.harness,
                lanes: request.harness?.lanes?.map(({ title, brief }) => ({ title, brief })),
            },
            agent: request.agent,
            recentChat: request.recentChat,
            status: "running",
            startedAt: new Date(),
            steps: 0,
            messages: [],
            updates: [],
            restarts: 0,
            reported: false,
        };
        const controller = new AbortController();
        this.tasks.set(task.id, { task, controller });
        this.changed(task);
        void this.execute(task, controller);
        return task;
    }

    list(userId?: string): BackgroundTask[] {
        return [...this.tasks.values()]
            .map(({ task }) => task)
            .filter((task) => userId === undefined || task.userId === userId);
    }

    running(userId: string): BackgroundTask[] {
        return this.list(userId).filter((task) => task.status === "running");
    }

    /** Finished tasks the orchestrator has not seen yet. Reading them marks them seen. */
    takeUnreported(userId: string): BackgroundTask[] {
        const finished = this.list(userId).filter((task) => task.status !== "running" && !task.reported);
        for (const task of finished) task.reported = true;
        if (finished.length) this.save();
        return finished;
    }

    /** A sub-agent took a step; the orchestrator can tell the user how far it got. */
    progress(id: string, tool: string): void {
        const task = this.tasks.get(id)?.task;
        if (task?.status !== "running") return;
        task.steps++;
        task.lastStep = tool;
        this.changed(task);
    }

    /** A sub-agent texts the user before its result: a first find, a question it settled, a delay. */
    async tellUser(id: string, text: string): Promise<void> {
        const task = this.tasks.get(id)?.task;
        if (task?.status !== "running") throw new Error("This task is not running any more.");
        if (task.updates.length >= MAX_UPDATES) {
            throw new Error(`You already sent ${MAX_UPDATES} updates. Keep the rest for your final answer.`);
        }
        task.updates.push(text);
        this.changed(task);
        await this.notify(task.userId, text);
    }

    /** Passes the user's change of plan to a running task; it reads it after its current step. */
    message(userId: string, id: string, text: string): boolean {
        const task = this.tasks.get(id)?.task;
        if (!task || task.userId !== userId || task.status !== "running") return false;
        task.messages.push(text);
        this.changed(task);
        return true;
    }

    cancel(userId: string, id: string): boolean {
        const entry = this.tasks.get(id);
        if (!entry || entry.task.userId !== userId || entry.task.status !== "running") return false;
        entry.task.status = "cancelled";
        entry.task.finishedAt = new Date();
        entry.controller.abort();
        this.changed(entry.task);
        return true;
    }

    private async execute(task: BackgroundTask, controller: AbortController): Promise<void> {
        // The runner is told the deadline and answers on its own; this only stops one that does not.
        const timer = setTimeout(
            () => controller.abort(new Error("it ran out of time")),
            deadlineOf(task) - Date.now() + GRACE_MS,
        );
        try {
            const result = await this.runner(task, controller.signal);
            if (task.status === "cancelled") return;
            task.status = "done";
            task.result = result;
        } catch (error) {
            if (task.status === "cancelled") return;
            task.status = "failed";
            const reason = controller.signal.aborted ? controller.signal.reason : error;
            task.result = reason instanceof Error ? reason.message : String(reason);
        } finally {
            clearTimeout(timer);
        }
        task.finishedAt = new Date();
        this.changed(task);
        const text = task.status === "done" ? (task.result ?? "") : `I couldn't finish "${task.title}": ${task.result}`;
        await this.notify(task.userId, text).catch((error) =>
            console.error(`[background ${task.id}] notify failed`, error),
        );
    }

    private save(): void {
        if (!this.file) return;
        mkdirSync(dirname(this.file), { recursive: true });
        const temporary = `${this.file}.tmp`;
        writeFileSync(
            temporary,
            JSON.stringify(
                [...this.tasks.values()].map(({ task }) => task),
                null,
                2,
            ),
        );
        renameSync(temporary, this.file);
    }

    private changed(task: BackgroundTask): void {
        this.save();
        this.emit(task.userId);
    }

    private emit(userId: string): void {
        for (const listener of this.listeners) listener(userId);
    }
}
