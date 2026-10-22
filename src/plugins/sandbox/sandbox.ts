import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { PluginHttpRequest, PluginHttpResponse } from "../broker.js";

/** Runs plugin code somewhere it can do nothing but compute and call `http`. */
export interface PluginSandbox {
    /** Calls one tool. `tool: null` lists the tools the code exports instead. */
    run(call: SandboxCall): Promise<unknown>;
}

export interface SandboxCall {
    code: string;
    tool: string | null;
    params: unknown;
    http: (request: PluginHttpRequest) => Promise<PluginHttpResponse>;
}

const RUNNER = fileURLToPath(new URL("./runner.mjs", import.meta.url));

type RunnerMessage =
    | { type: "http"; id: number; request: PluginHttpRequest }
    | { type: "result"; ok: true; data: unknown }
    | { type: "result"; ok: false; error: string };

/**
 * One short-lived Node process per call, under the permission model: it may read only the
 * runner file, has an empty environment, a small heap and a deadline. Good for development
 * and tests; a hosted sandbox with no network at all is the production target.
 */
export class NodeSandbox implements PluginSandbox {
    constructor(private readonly options: { timeoutMs: number } = { timeoutMs: 20_000 }) {}

    run(call: SandboxCall): Promise<unknown> {
        const child = fork(RUNNER, [], {
            execArgv: [
                "--permission",
                `--allow-fs-read=${RUNNER}`,
                "--disallow-code-generation-from-strings",
                "--max-old-space-size=64",
            ],
            env: {},
            stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (outcome: () => void) => {
                if (settled) return;
                settled = true;
                clearTimeout(deadline);
                child.kill("SIGKILL");
                outcome();
            };
            const deadline = setTimeout(
                () => settle(() => reject(new Error(`The plugin took longer than ${this.options.timeoutMs} ms`))),
                this.options.timeoutMs,
            );
            child.on("message", (message: RunnerMessage) => {
                if (message.type === "result") {
                    settle(() => (message.ok ? resolve(message.data) : reject(new Error(message.error))));
                    return;
                }
                call.http(message.request).then(
                    (response) => child.connected && child.send({ type: "http", id: message.id, response }),
                    (error: Error) =>
                        child.connected && child.send({ type: "http", id: message.id, error: error.message }),
                );
            });
            child.on("error", (error) => settle(() => reject(error)));
            child.on("exit", (code) =>
                settle(() => reject(new Error(`The plugin exited without answering (${code})`))),
            );
            child.send({ type: "call", code: call.code, tool: call.tool, params: call.params });
        });
    }
}
