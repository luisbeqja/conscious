import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import type { LinkedMac, MacLinks } from "./links.js";
import {
    type ChatLinks,
    CLOSE,
    type FromMac,
    MAC_OFFERS_PATH,
    MAC_PAIR_PATH,
    MAC_SOCKET_PATH,
    type MacAnswer,
    type MacFolder,
    type MacRequest,
    PROTOCOL_VERSION,
    type ToMac,
} from "./protocol.js";

const HELLO_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
/** Answers are text: far less than this. */
const MAX_PAYLOAD_BYTES = 2_000_000;
const MAX_BODY_BYTES = 4_096;
/** Steps kept per job, for "how is it going". */
const STEPS_KEPT = 8;
/** Conversations with Claude Code kept per user, for the next job to go on with. */
const CONVERSATIONS_KEPT = 5;

interface Connection {
    socket: WebSocket;
    mac: LinkedMac;
    folders: MacFolder[];
}

/** A job Claude Code works on, until its answer arrives. It outlives a Mac dropping off and coming back. */
interface Job {
    id: string;
    userId: string;
    request: MacRequest;
    startedAt: Date;
    steps: string[];
    resolve: (answer: MacAnswer) => void;
    reject: (error: Error) => void;
}

/** A conversation with Claude Code that a later job can go on with, so it remembers the work. */
interface Conversation {
    /** The folder's path on the Mac. */
    folder: string;
    session: string;
    /** What it was first asked, to tell conversations apart. */
    about: string;
    at: Date;
}

export interface MacStatus {
    name: string;
    online: boolean;
    /** Where Claude Code may work, as the Mac reported it when it connected. */
    folders: MacFolder[];
    working: { folder: string; asked: string; minutes: number; lastSteps: string[] }[];
    /** The latest first. */
    conversations: { folder: string; session: string; about: string; minutesAgo: number }[];
}

export interface MacBridgeOptions {
    /** A Mac connected for the first time since it was linked. */
    onLinked?: (userId: string, name: string, folders: readonly MacFolder[]) => void;
    now?: () => Date;
}

const parse = (raw: RawData): FromMac | undefined => {
    try {
        const message = JSON.parse(raw.toString()) as FromMac;
        return typeof message === "object" && message !== null ? message : undefined;
    } catch {
        return undefined;
    }
};

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");

const cleanFolders = (folders: unknown): MacFolder[] =>
    (Array.isArray(folders) ? folders : [])
        .slice(0, 50)
        .map((folder: Partial<MacFolder>) => ({ name: text(folder?.name, 200), path: text(folder?.path, 1_000) }))
        .filter((folder) => folder.name && folder.path);

const cleanAnswer = (answer: Partial<MacAnswer> | undefined): MacAnswer => ({
    session: text(answer?.session, 100),
    folder: text(answer?.folder, 1_000),
    text: text(answer?.text, 200_000),
    error: answer?.error === true,
    denied: (Array.isArray(answer?.denied) ? answer.denied : []).slice(0, 20).map((step) => text(step, 300)),
    turns: typeof answer?.turns === "number" ? answer.turns : 0,
    costUsd: typeof answer?.costUsd === "number" ? answer.costUsd : undefined,
});

const readBody = (request: IncomingMessage): Promise<string | undefined> =>
    new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                resolve(undefined);
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        request.on("error", reject);
    });

/**
 * Conscious's end of the link to the users' Macs. A Mac holds a socket open to `/mac/socket` and
 * runs Claude Code when it is asked to; this side never reaches into the Mac any other way.
 */
export class MacBridge {
    private readonly connections = new Map<string, Connection>();
    private readonly jobs = new Map<string, Job>();
    private readonly conversations = new Map<string, Conversation[]>();
    private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
    private readonly heartbeat: NodeJS.Timeout;
    private readonly now: () => Date;
    /** The chat links a Mac's QR opens. Set once the channels run, since they start after Conscious. */
    chatLinks?: (code: string) => ChatLinks;

    constructor(
        private readonly links: MacLinks,
        private readonly options: MacBridgeOptions = {},
    ) {
        this.now = options.now ?? (() => new Date());
        const alive = new WeakSet<WebSocket>();
        this.sockets.on("connection", (socket) => {
            alive.add(socket);
            socket.on("pong", () => alive.add(socket));
            this.accept(socket);
        });
        // A Mac that goes to sleep drops the connection without closing it; a missed pong frees it.
        this.heartbeat = setInterval(() => {
            for (const socket of this.sockets.clients) {
                if (!alive.has(socket)) {
                    socket.terminate();
                    continue;
                }
                alive.delete(socket);
                socket.ping();
            }
        }, HEARTBEAT_MS);
        this.heartbeat.unref();
    }

    /**
     * The Macs' JSON requests, all POST. `/mac/pair` trades a code from /mac for a token; `/mac/offers`
     * gives a Mac a code to show as a QR, and `/mac/offers/collect` its token once the owner sent the
     * code from their chat. False for other paths.
     */
    serve = (request: IncomingMessage, response: ServerResponse): boolean => {
        const path = request.url?.split("?")[0];
        const routes: Record<string, (given: Record<string, unknown>) => [number, object]> = {
            [MAC_PAIR_PATH]: (given) => {
                const paired = this.links.pair(text(given.code, 100), text(given.name, 100));
                if (!paired) {
                    return [
                        403,
                        {
                            error: "That code does not work: it was used, or more than 15 minutes passed. Send /mac in the chat for a new one.",
                        },
                    ];
                }
                this.linked(paired.userId);
                return [200, { token: paired.token }];
            },
            [MAC_OFFERS_PATH]: (given) => {
                const name = text(given.name, 100);
                const offer = this.links.offer(name);
                const links = this.chatLinks?.(offer.code) ?? {};
                console.log(`[mac] a QR code is shown on ${JSON.stringify(name)}`);
                return [200, { ...offer, links }];
            },
            [`${MAC_OFFERS_PATH}/collect`]: (given) => {
                const collected = this.links.collect(text(given.code, 100), text(given.secret, 100));
                if (collected === "waiting") return [202, { waiting: true }];
                if (!collected) return [410, { error: "This code expired. Show a new QR." }];
                this.linked(collected.userId);
                return [200, { token: collected.token }];
            },
        };
        const route = path ? routes[path] : undefined;
        if (!route) return false;
        const reply = ([status, body]: [number, object]) =>
            response
                .writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
                .end(JSON.stringify(body));
        if (request.method !== "POST") {
            reply([405, { error: "Link a Mac with pnpm mac." }]);
            return true;
        }
        void readBody(request)
            .then((body) => reply(route(JSON.parse(body || "{}") as Record<string, unknown>)))
            .catch(() => reply([400, { error: "Send JSON." }]));
        return true;
    };

    /** A Mac was linked in place of the user's old one, which stops at once. */
    private linked(userId: string): void {
        this.connections.get(userId)?.socket.close(CLOSE.unlinked, "another Mac was linked");
        console.log(`[mac] a Mac was linked for ${userId}`);
    }

    /** Takes the Macs' sockets at `/mac/socket`. False for any other upgrade. */
    upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
        if (request.url?.split("?")[0] !== MAC_SOCKET_PATH) return false;
        this.sockets.handleUpgrade(request, socket, head, (ws) => this.sockets.emit("connection", ws, request));
        return true;
    };

    /** The user's Mac, whether it is online, and what Claude Code is doing there. Undefined when none is linked. */
    status(userId: string): MacStatus | undefined {
        const mac = this.links.linked(userId);
        if (!mac) return undefined;
        const connection = this.connections.get(userId);
        return {
            name: mac.name,
            online: connection !== undefined,
            folders: connection?.folders ?? [],
            working: [...this.jobs.values()]
                .filter((job) => job.userId === userId)
                .map((job) => ({
                    folder: job.request.folder,
                    asked: job.request.message.slice(0, 200),
                    minutes: Math.floor((this.now().getTime() - job.startedAt.getTime()) / 60_000),
                    lastSteps: job.steps,
                })),
            conversations: (this.conversations.get(userId) ?? []).map((conversation) => ({
                folder: basename(conversation.folder),
                session: conversation.session,
                about: conversation.about,
                minutesAgo: Math.floor((this.now().getTime() - conversation.at.getTime()) / 60_000),
            })),
        };
    }

    /**
     * Gives Claude Code on the user's Mac a job and waits for its answer, however long it works.
     * A Mac that drops off meanwhile gets the job again when it is back, and answers it once;
     * `signal` gives up and stops Claude Code.
     */
    ask(userId: string, request: MacRequest, signal?: AbortSignal): Promise<MacAnswer> {
        const connection = this.connections.get(userId);
        if (!this.links.linked(userId)) return Promise.reject(new Error("No Mac is linked. The user can send /mac."));
        if (!connection) {
            return Promise.reject(
                new Error("The Mac is offline: it is asleep, off the internet, or conscious-mac is not running on it."),
            );
        }
        return new Promise<MacAnswer>((resolve, reject) => {
            const id = randomUUID();
            const stopped = () =>
                signal?.reason instanceof Error ? signal.reason : new Error("Claude Code was stopped");
            if (signal?.aborted) return reject(stopped());
            const stop = () => {
                if (!this.jobs.delete(id)) return;
                const live = this.connections.get(userId);
                if (live) this.send(live.socket, { type: "cancel", id });
                reject(stopped());
            };
            signal?.addEventListener("abort", stop, { once: true });
            const done = () => signal?.removeEventListener("abort", stop);
            this.jobs.set(id, {
                id,
                userId,
                request,
                startedAt: this.now(),
                steps: [],
                resolve: (answer) => {
                    done();
                    resolve(answer);
                },
                reject: (error) => {
                    done();
                    reject(error);
                },
            });
            this.send(connection.socket, { type: "ask", id, request });
        });
    }

    /** Closes the user's connection, once their Mac is unlinked. */
    disconnect(userId: string): void {
        this.connections.get(userId)?.socket.close(CLOSE.unlinked, "this Mac was unlinked");
        this.connections.delete(userId);
        for (const job of [...this.jobs.values()].filter((entry) => entry.userId === userId)) {
            this.jobs.delete(job.id);
            job.reject(new Error("The Mac was unlinked."));
        }
    }

    close(): void {
        clearInterval(this.heartbeat);
        this.sockets.close();
    }

    private accept(socket: WebSocket): void {
        let connection: Connection | undefined;
        const timeout = setTimeout(() => socket.close(CLOSE.noHello, "no hello"), HELLO_TIMEOUT_MS);
        socket.on("message", (raw) => {
            const message = parse(raw);
            if (!message) return;
            if (connection) return this.handle(connection, message);
            if (message.type !== "hello" || typeof message.token !== "string") return;
            clearTimeout(timeout);
            const mac = this.links.macFor(message.token);
            if (!mac) return socket.close(CLOSE.unlinked, "this Mac is not linked");
            if (message.version !== PROTOCOL_VERSION) return socket.close(CLOSE.outdated, "update conscious-mac");
            connection = { socket, mac, folders: cleanFolders(message.folders) };
            this.connections.get(mac.userId)?.socket.close(CLOSE.replaced, "a newer connection took over");
            this.connections.set(mac.userId, connection);
            this.send(socket, { type: "welcome", user: mac.userId });
            // Jobs given before it dropped off: it answers the ones it knows, and starts the ones it lost.
            for (const job of this.jobs.values()) {
                if (job.userId === mac.userId) this.send(socket, { type: "ask", id: job.id, request: job.request });
            }
            console.log(`[mac] ${mac.name} connected for ${mac.userId}`);
            if (this.links.connected(mac)) this.options.onLinked?.(mac.userId, mac.name, connection.folders);
        });
        socket.on("close", () => {
            clearTimeout(timeout);
            if (!connection || this.connections.get(connection.mac.userId) !== connection) return;
            this.connections.delete(connection.mac.userId);
            console.log(`[mac] ${connection.mac.name} disconnected`);
        });
    }

    private handle(connection: Connection, message: FromMac): void {
        if (message.type === "folders") {
            connection.folders = cleanFolders(message.folders);
            return;
        }
        if (message.type === "hello") return;
        if (message.type === "unlink") {
            const { userId, name } = connection.mac;
            this.disconnect(userId);
            this.links.forget(userId);
            console.log(`[mac] ${name} was unlinked from the Mac`);
            return;
        }
        const job = this.jobs.get(text(message.id, 100));
        // Only the user's own Mac can answer their job.
        if (!job || job.userId !== connection.mac.userId) return;
        if (message.type === "step") {
            job.steps = [...job.steps, text(message.step, 200)].slice(-STEPS_KEPT);
            return;
        }
        this.jobs.delete(job.id);
        if (message.type === "failed") {
            job.reject(new Error(text(message.reason, 1_000) || "Claude Code failed on the Mac"));
            return;
        }
        const answer = cleanAnswer(message.answer);
        if (answer.session) this.remember(job, answer);
        job.resolve(answer);
    }

    /** The conversation a job had, latest first: one it went on with keeps what it was first about. */
    private remember(job: Job, answer: MacAnswer): void {
        const kept = this.conversations.get(job.userId) ?? [];
        const before = kept.find((conversation) => conversation.session === answer.session);
        const conversation: Conversation = {
            folder: answer.folder,
            session: answer.session,
            about: before?.about ?? job.request.message.replace(/\s+/g, " ").slice(0, 160),
            at: this.now(),
        };
        this.conversations.set(
            job.userId,
            [conversation, ...kept.filter((entry) => entry !== before)].slice(0, CONVERSATIONS_KEPT),
        );
    }

    private send(socket: WebSocket, message: ToMac): void {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    }
}
