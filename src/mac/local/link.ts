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
/** Jobs shown on the Mac's page. */
const ACTIVITY_KEPT = 20;

type Reply = Extract<FromMac, { type: "answer" | "failed" }>;

interface Job {
    stop?: () => void;
    reply?: Reply;
    endedAt?: number;
}

/** Why the link ended: stopped here, or the server no longer takes this Mac. */
export type LinkEnd = "stopped" | "unlinked" | "outdated";

/** Where the link stands, for the Mac's page. */
export type LinkState = "connecting" | "online" | "offline" | LinkEnd;

/** A job as the Mac's page shows it. */
export interface Activity {
    id: string;
    folder: string;
    asked: string;
    readOnly: boolean;
    startedAt: string;
    endedAt?: string;
    result: "working" | "answered" | "failed";
    steps: number;
    lastStep?: string;
    reason?: string;
}

export interface MacLinkOptions {
    log?: (line: string) => void;
    /** Passed to every Claude Code run; tests turn it off. */
    caffeinate?: boolean;
}

const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
    });

/**
 * The Mac's end of the link: a socket held open to Conscious, and Claude Code started for each job
 * it is given. Jobs are known by id, so one given again after a reconnect is answered, not done twice.
 */
export class MacLink {
    private socket?: WebSocket;
    private readonly jobs = new Map<string, Job>();
    private readonly recent: Activity[] = [];
    private readonly log: (line: string) => void;
    private current: LinkState = "connecting";

    constructor(
        private readonly file: string,
        private readonly options: MacLinkOptions = {},
    ) {
        this.log = options.log ?? ((line) => console.log(`${new Date().toISOString()} ${line}`));
    }

    get state(): LinkState {
        return this.current;
    }

    /** The latest jobs, newest first. */
    activity(): readonly Activity[] {
        return this.recent;
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
                if (!settings?.token) return this.ended("unlinked");
                this.current = "connecting";
                const { code, opened } = await this.connect(settings, signal);
                if (signal.aborted) break;
                if (code === CLOSE.unlinked) {
                    // Linked again meanwhile: the new token is in the file.
                    if (this.settings()?.token !== settings.token) continue;
                    return this.ended("unlinked");
                }
                if (code === CLOSE.outdated) return this.ended("outdated");
                if (opened) wait = 1_000;
                this.current = "offline";
                this.log(`Not connected to ${settings.server}; trying again in ${wait / 1_000}s`);
                await sleep(wait, signal);
                wait = Math.min(wait * 2, MAX_WAIT_MS);
            }
            return this.ended("stopped");
        } finally {
            unwatchFile(this.file, changed);
            this.socket?.close();
            for (const job of this.jobs.values()) job.stop?.();
        }
    }

    /**
     * What runs in the background: linked while the settings hold a token, and waiting for a new one
     * when they do not, until `signal`. The Mac's page stays up all the while.
     */
    async stayLinked(signal: AbortSignal): Promise<void> {
        while (!signal.aborted) {
            const token = this.settings()?.token;
            if ((await this.run(signal)) === "stopped") return;
            while (!signal.aborted && this.settings()?.token === token) await sleep(1_000, signal);
        }
    }

    /** Tells Conscious the user unlinked this Mac here, so it forgets it too. */
    unlink(): void {
        this.send({ type: "unlink" });
    }

    private ended(end: LinkEnd): LinkEnd {
        this.current = end;
        return end;
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
        if (message.type === "welcome") {
            this.current = "online";
            this.log(`Connected, for ${message.user}`);
        }
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
        const activity: Activity = {
            id,
            folder: String(request.folder ?? ""),
            asked: String(request.message ?? "").slice(0, 160),
            readOnly: request.readOnly === true,
            startedAt: new Date(now).toISOString(),
            result: "working",
            steps: 0,
        };
        this.recent.unshift(activity);
        this.recent.splice(ACTIVITY_KEPT);
        const settings = this.settings();
        const folder = settings && resolveFolder(activity.folder, settings.folders);
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
            readOnly: activity.readOnly,
            permissionMode: settings.permissionMode,
            model: settings.model,
            caffeinate: this.options.caffeinate,
            onStep: (step) => {
                activity.steps++;
                activity.lastStep = step;
                this.send({ type: "step", id, step });
            },
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
        const activity = this.recent.find((entry) => entry.id === id);
        if (activity) {
            activity.endedAt = new Date().toISOString();
            activity.result = reply.type === "answer" && !reply.answer.error ? "answered" : "failed";
            if (reply.type === "failed") activity.reason = reply.reason;
        }
        this.log(`Job ${id.slice(0, 8)} ${reply.type === "answer" ? "answered" : `failed: ${reply.reason}`}`);
        this.send(reply);
    }

    private send(message: FromMac): void {
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
    }
}
