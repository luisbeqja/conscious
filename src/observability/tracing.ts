import type { AgentEvent } from "@earendil-works/pi-agent-core";

/** What a run's trace starts with. */
export interface TraceStart {
    /** What kind of run: a message, going on after the user acted elsewhere, a background job, a check. */
    name: string;
    /** The user's id. Tracers keep only a hash of it: ids are phone numbers. */
    userId: string;
    /** The run's prompt: the user's message, or a job's brief. */
    input: string;
    model: string;
}

/** One agent run, as a trace: each model turn and each tool call in it. */
export interface RunTrace {
    event(event: AgentEvent): void;
    end(outcome: { status: string; text: string; error?: string }): void;
}

/** Where traces go. Without one configured, runs are not traced. */
export interface Tracer {
    start(run: TraceStart): RunTrace;
    /** Sends what is still buffered; for a clean stop. */
    flush(): Promise<void>;
}

const quiet: RunTrace = { event: () => {}, end: () => {} };

export const noTracing: Tracer = { start: () => quiet, flush: async () => {} };
