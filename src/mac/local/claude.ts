import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { MacAnswer } from "../protocol.js";

/** Added to Claude Code's own system prompt on every job from Conscious. */
const RELAYED = [
    "This job comes from Conscious, the user's personal assistant, which relays your answer to their phone.",
    "The user is away from this computer and nobody can answer a prompt here: anything that needs approval is refused.",
    "Do what you can with what you are allowed; when you need a decision or a permission, stop and say exactly what you need.",
    "End with a short report that reads well on a phone: what you did, what you found, what is left.",
].join(" ");

/** A Claude Code session id. A value from the server must never pass as a flag. */
const SESSION = /^[0-9a-f][0-9a-f-]{7,63}$/i;

export interface ClaudeJob {
    /** The Claude Code program. */
    claude: string;
    /** An allowed folder, already checked. */
    folder: string;
    message: string;
    session?: string;
    readOnly?: boolean;
    permissionMode: string;
    model?: string;
    /** Each step as it starts, like "Edit src/app.ts". */
    onStep?: (step: string) => void;
    /** Keeps the Mac awake while Claude Code works. On unless false. */
    caffeinate?: boolean;
}

/** The arguments for one turn of Claude Code, printed as JSON lines and refused anything that would prompt. */
export const claudeArgs = (job: ClaudeJob): string[] => [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-prompts",
    "none",
    "--permission-mode",
    job.readOnly ? "plan" : job.permissionMode,
    "--append-system-prompt",
    RELAYED,
    ...(job.model ? ["--model", job.model] : []),
    ...(job.session ? ["--resume", job.session] : []),
];

const short = (value: unknown, max = 120): string => {
    const line = (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** A tool call as one line: "Bash: npm test", "Edit src/app.ts". */
export const describeStep = (tool: string, input: Record<string, unknown> | undefined): string => {
    if (tool === "Bash") return input?.command ? `Bash: ${short(input.command)}` : tool;
    const target = short(
        input?.file_path ?? input?.notebook_path ?? input?.pattern ?? input?.url ?? input?.query ?? input?.description,
    );
    return target ? `${tool} ${target}` : tool;
};

interface StreamEvent {
    type?: string;
    subtype?: string;
    session_id?: string;
    message?: { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] };
    result?: string;
    is_error?: boolean;
    num_turns?: number;
    total_cost_usd?: number;
    permission_denials?: { tool_name?: string; tool_input?: Record<string, unknown> }[];
}

const parseLine = (line: string): StreamEvent | undefined => {
    try {
        return JSON.parse(line) as StreamEvent;
    } catch {
        return undefined;
    }
};

/**
 * One turn of Claude Code in the folder: the message on its input, its steps as they start, its
 * answer at the end. `stop` interrupts it, and the answer then fails.
 */
export const runClaude = (job: ClaudeJob): { answer: Promise<MacAnswer>; stop: () => void } => {
    if (job.session && !SESSION.test(job.session)) {
        return { answer: Promise.reject(new Error("That is not a Claude Code session id.")), stop: () => {} };
    }
    const child = spawn(job.claude, claudeArgs(job), { cwd: job.folder, stdio: ["pipe", "pipe", "pipe"] });
    if (job.caffeinate !== false && child.pid) {
        // Awake while Claude Code works; free to sleep once it is done.
        spawn("caffeinate", ["-i", "-w", String(child.pid)], { stdio: "ignore" })
            .on("error", () => {})
            .unref();
    }
    child.stdin.on("error", () => {});
    child.stdin.end(job.message);
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => {
        errors = `${errors}${chunk.toString()}`.slice(-2_000);
    });
    let stopped = false;
    const answer = new Promise<MacAnswer>((resolve, reject) => {
        let session = job.session ?? "";
        let result: MacAnswer | undefined;
        createInterface({ input: child.stdout }).on("line", (line) => {
            const event = parseLine(line);
            if (event?.session_id) session = event.session_id;
            if (event?.type === "assistant") {
                for (const block of event.message?.content ?? []) {
                    if (block.type === "tool_use" && block.name) job.onStep?.(describeStep(block.name, block.input));
                }
            }
            if (event?.type !== "result") return;
            result = {
                session,
                folder: job.folder,
                text: event.result ?? "",
                error: event.is_error === true,
                denied: (event.permission_denials ?? []).map((denial) =>
                    describeStep(denial.tool_name ?? "a tool", denial.tool_input),
                ),
                turns: event.num_turns ?? 0,
                costUsd: event.total_cost_usd,
            };
        });
        child.on("error", (error) =>
            reject(new Error(`Claude Code could not start (${job.claude}): ${error.message}`)),
        );
        child.on("close", (code) => {
            if (result && !stopped) return resolve(result);
            reject(
                new Error(
                    stopped
                        ? "Claude Code was stopped."
                        : `Claude Code ended without an answer (exit ${code}). ${errors.trim().slice(-500)}`.trim(),
                ),
            );
        });
    });
    const stop = () => {
        stopped = true;
        child.kill("SIGINT");
        setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 5_000).unref();
    };
    return { answer, stop };
};
