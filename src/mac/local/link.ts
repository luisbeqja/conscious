import { unwatchFile, watchFile } from "node:fs";
import WebSocket from "ws";
import { CLOSE, type FromMac, MAC_SOCKET_PATH, type MacRequest, PROTOCOL_VERSION, type ToMac } from "../protocol.js";
import { runClaude } from "./claude.js";
import { listFolders, resolveFolder } from "./folders.js";
import { type MacSettings, readSettings } from "./settings.js";

/** A finished job's reply is kept this long, for a server that missed it while the link was down. */
const KEEP_MS = 24 * 60 * 60_000;
/** The server pings every 30 seconds: this long without hearing from it, the link is gone. */
const SILENCE_MS = 75_000;
const MAX_WAIT_MS = 30_000;

type Reply = Extract<FromMac, { type: "answer" | "failed" }>;

interface Job {
    stop?: () => void;
    reply?: Reply;
    endedAt?: number;
}

/** Why the link ended: stopped here, or the server no longer takes this Mac. */
export type LinkEnd = "stopped" | "unlinked" | "outdated";

export interface MacLinkOptions {
    log?: (line: string) => void;
    /** Passed to every Claude Code run; tests turn it off. */
    caffeinate?: boolean;
}

const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
        });
    });

/**
 * The Mac's end of the link: a socket held open to Conscious, and Claude Code started for each job
 * it is given. Jobs are known by id, so one given again after a reconnect is answered, not done twice.
 */
export class MacLink {
    private socket?: WebSocket;
    private readonly jobs = new Map<string, Job>();
    private readonly log: (line: string) => void;

    constructor(
        private readonly file: string,
        private readonly options: MacLinkOptions = {},
    ) {
        this.log = options.log ?? ((line) => console.log(`${new Date().toISOString()} ${line}`));
    }

    /** Stays connected, coming back after every drop, until `signal` or the server says this Mac is not linked. */
    async run(signal: AbortSignal): Promise<LinkEnd> {
        // A folder allowed while it runs reaches the chat without a restart.
        const changed = () => {
            const settings = this.settings();
            if (settings) this.send({ type: "folders", folders: listFolders(settings.folders) });
        };
        watchFile(this.file, { interval: 2_000 }, changed);
        let wait = 1_000;
        try {
            while (!signal.aborted) {
                const settings = this.settings();
                if (!settings) return "unlinked";
                const { code, opened } = await this.connect(settings, signal);
                if (signal.aborted) break;
                if (code === CLOSE.unlinked) {
                    // Paired again meanwhile: the new token is in the file.
                    if (this.settings()?.token !== settings.token) continue;
                    return "unlinked";
                }
                if (code === CLOSE.outdated) return "outdated";
                if (opened) wait = 1_000;
                this.log(`Not connected to ${settings.server}; trying again in ${wait / 1_000}s`);
                await sleep(wait, signal);
                wait = Math.min(wait * 2, MAX_WAIT_MS);
            }
            return "stopped";
        } finally {
            unwatchFile(this.file, changed);
            this.socket?.close();
            for (const job of this.jobs.values()) job.stop?.();
        }
    }

    private settings(): MacSettings | undefined {
        try {
            return readSettings(this.file);
        } catch (error) {
            this.log(`Could not read ${this.file}: ${error instanceof Error ? error.message : error}`);
            return undefined;
        }
    }

    private connect(settings: MacSettings, signal: AbortSignal): Promise<{ code: number; opened: boolean }> {
        return new Promise((resolve) => {
            const url = new URL(MAC_SOCKET_PATH, settings.server);
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
            const socket = new WebSocket(url);
            this.socket = socket;
            let opened = false;
            let silence: NodeJS.Timeout | undefined;
            const heard = () => {
                clearTimeout(silence);
                silence = setTimeout(() => socket.terminate(), SILENCE_MS);
            };
            const leave = () => socket.close(1000);
            signal.addEventListener("abort", leave, { once: true });
            socket.on("open", () => {
                opened = true;
                heard();
                this.send({
                    type: "hello",
                    token: settings.token,
                    name: settings.name,
                    version: PROTOCOL_VERSION,
                    folders: listFolders(settings.folders),
                });
            });
            socket.on("ping", heard);
            socket.on("message", (raw) => {
                heard();
                this.handle(raw.toString());
            });
            socket.on("error", (error) => this.log(`Connection error: ${error.message}`));
            socket.on("close", (code) => {
                clearTimeout(silence);
                signal.removeEventListener("abort", leave);
                if (this.socket === socket) this.socket = undefined;
                resolve({ code, opened });
            });
        });
    }

    private handle(raw: string): void {
        let message: ToMac;
        try {
            message = JSON.parse(raw) as ToMac;
        } catch {
            return;
        }
        if (message.type === "welcome") this.log(`Connected, for ${message.user}`);
        if (message.type === "cancel") this.jobs.get(message.id)?.stop?.();
        if (message.type === "ask") this.start(message.id, message.request);
    }

    private start(id: string, request: MacRequest): void {
        const now = Date.now();
        for (const [key, job] of this.jobs) if (job.endedAt && now - job.endedAt > KEEP_MS) this.jobs.delete(key);
        const known = this.jobs.get(id);
        if (known) {
            // Given again after a reconnect: still at work on it, or done while the link was down.
            if (known.reply) this.send(known.reply);
            return;
        }
        const settings = this.settings();
        const folder = settings && resolveFolder(String(request.folder ?? ""), settings.folders);
        if (!settings || !folder) {
            const allowed = settings?.folders.length
                ? listFolders(settings.folders)
                      .map((entry) => entry.name)
                      .join(", ")
                : "none yet (pnpm mac allow <folder>)";
            this.finish(id, {
                type: "failed",
                id,
                reason: `"${request.folder}" is not a folder Claude Code may use on this Mac. Allowed: ${allowed}.`,
            });
            return;
        }
        this.log(
            `Job ${id.slice(0, 8)} in ${folder}${request.readOnly ? ", read only" : ""}${request.session ? `, going on with ${String(request.session).slice(0, 8)}` : ""}`,
        );
        const run = runClaude({
            claude: settings.claude,
            folder,
            message: String(request.message ?? ""),
            session: request.session,
            readOnly: request.readOnly === true,
            permissionMode: settings.permissionMode,
            model: settings.model,
            caffeinate: this.options.caffeinate,
            onStep: (step) => this.send({ type: "step", id, step }),
        });
        this.jobs.set(id, { stop: run.stop });
        run.answer.then(
            (answer) => this.finish(id, { type: "answer", id, answer }),
            (error: unknown) =>
                this.finish(id, { type: "failed", id, reason: error instanceof Error ? error.message : String(error) }),
        );
    }

    private finish(id: string, reply: Reply): void {
        this.jobs.set(id, { reply, endedAt: Date.now() });
        this.log(`Job ${id.slice(0, 8)} ${reply.type === "answer" ? "answered" : `failed: ${reply.reason}`}`);
        this.send(reply);
    }

    private send(message: FromMac): void {
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
    }
}
