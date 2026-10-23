import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import type { AppConfig } from "../config.js";
import type { SendOptions } from "../engine/orchestrator.js";
import type { IncomingFile, OutgoingFile } from "../media/incoming.js";
import { type AppEntry, type AppFile, AppLog } from "./app-log.js";

/** The parts of the orchestrator the app needs. */
export interface AppAnswerer {
    send(userId: string, text: string, options: SendOptions): Promise<string>;
    /** Forgets the user: conversation, memory, reminders. */
    startFresh(userId: string): Promise<void>;
}

/** What the phone sends. */
export type ClientMessage =
    | { type: "auth"; code: string }
    | {
          type: "send";
          clientId: string;
          text: string;
          files?: { name: string; mimeType: string; data: string }[];
      }
    /** Start over: Conscious forgets this user and the chat is emptied on every open phone. */
    | { type: "reset" };

/** What the phone receives. The app keeps a copy of these types in `mobile/src/protocol.ts`. */
export type ServerMessage =
    | { type: "ready"; history: AppEntry[] }
    | { type: "ack"; clientId: string; entry: AppEntry }
    | { type: "entry"; entry: AppEntry }
    | { type: "typing"; active: boolean }
    | { type: "delta"; text: string }
    | { type: "tool"; name: string }
    | { type: "reaction"; entryId: string; emoji: string }
    | { type: "error"; message: string };

const HISTORY = 200;
const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
// Base64 makes a 20 MB photo about 27 MB on the wire.
const MAX_PAYLOAD_BYTES = 30_000_000;
const MAX_TEXT_CHARS = 20_000;

const digest = (code: string) => createHash("sha256").update(code).digest();

/** Codes look like `k7qd-m2xa-9wfe-c4tn`: easy to type on a phone, 80 bits. */
const newCode = (): string =>
    [...randomBytes(16)]
        .map((byte) => "abcdefghjkmnpqrstuvwxyz23456789"[byte % 31])
        .join("")
        .match(/.{4}/g)
        ?.join("-") ?? "";

/**
 * One access code per app user, created the first time a user is listed and kept in the
 * data folder (owner-only), like the Vault key. Returns the codes and which ones are new.
 */
export const loadOrCreateAppCodes = (
    file: string,
    userIds: readonly string[],
): { codes: Map<string, string>; created: string[] } => {
    const saved = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>) : {};
    const created = userIds.filter((userId) => !saved[userId]);
    for (const userId of created) saved[userId] = newCode();
    if (created.length) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
    }
    return { codes: new Map(userIds.map((userId) => [userId, saved[userId] as string])), created };
};

/**
 * Conscious in its own phone app: a WebSocket per open app, replies streamed as they are
 * written, tool use and reactions shown live. A user is whoever holds their access code,
 * so an app user with a WhatsApp user's id shares that conversation.
 */
export class AppChannel {
    private readonly sockets = new Map<string, Set<WebSocket>>();
    private readonly running = new Map<string, number>();
    private readonly codes: { userId: string; digest: Buffer }[];

    constructor(
        private readonly orchestrator: AppAnswerer,
        codes: ReadonlyMap<string, string>,
        private readonly log: AppLog,
    ) {
        this.codes = [...codes].map(([userId, code]) => ({ userId, digest: digest(code) }));
    }

    /**
     * The app's HTTP server: the socket at `/app/socket`, files at `/app/files/<id>`. Other paths
     * go to `others`, when the app shares its port (the Vault, on a host with one address).
     */
    createServer(others?: RequestListener): Server {
        const server = createServer((request, response) =>
            others && !request.url?.startsWith("/app/") ? others(request, response) : this.serveHttp(request, response),
        );
        const sockets = new WebSocketServer({ server, path: "/app/socket", maxPayload: MAX_PAYLOAD_BYTES });
        sockets.on("connection", (socket) => this.accept(socket));
        const alive = new WeakSet<WebSocket>();
        sockets.on("connection", (socket) => {
            alive.add(socket);
            socket.on("pong", () => alive.add(socket));
        });
        // Phones drop connections without closing them; a missed pong frees the socket.
        const heartbeat = setInterval(() => {
            for (const socket of sockets.clients) {
                if (!alive.has(socket)) {
                    socket.terminate();
                    continue;
                }
                alive.delete(socket);
                socket.ping();
            }
        }, HEARTBEAT_MS);
        server.on("close", () => {
            clearInterval(heartbeat);
            sockets.close();
        });
        return server;
    }

    /** Whether the user has written in the app more recently than `than`. */
    wroteHereSince(userId: string, than: Date | undefined): boolean {
        const last = this.log.lastUserMessageAt(userId);
        return Boolean(last && (!than || last > than));
    }

    hasUser(userId: string): boolean {
        return this.codes.some((code) => code.userId === userId);
    }

    /** How Conscious speaks first in the app: kept in the chat, and shown at once on any open phone. */
    notify = async (userId: string, text: string): Promise<void> => {
        this.broadcast(userId, { type: "entry", entry: this.log.add(userId, { role: "assistant", text }) });
    };

    userFor(code: string): string | undefined {
        const given = digest(code.trim().toLowerCase());
        return this.codes.find((entry) => timingSafeEqual(entry.digest, given))?.userId;
    }

    private serveHttp(request: IncomingMessage, response: ServerResponse): void {
        const url = new URL(request.url ?? "/", "http://app");
        if (url.pathname === "/app/health") {
            response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
            return;
        }
        const match = /^\/app\/files\/([^/]+)$/.exec(url.pathname);
        const code = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
        const userId = code && this.userFor(code);
        const found = match?.[1] && userId ? this.log.readFile(userId, match[1]) : undefined;
        if (!found) {
            response.writeHead(404).end();
            return;
        }
        response
            .writeHead(200, {
                "content-type": found.file.mimeType,
                "content-length": found.data.byteLength,
                "cache-control": "private, max-age=31536000, immutable",
                "content-disposition": `inline; filename="${encodeURIComponent(found.file.name)}"`,
                "x-content-type-options": "nosniff",
            })
            .end(found.data);
    }

    private accept(socket: WebSocket): void {
        let userId: string | undefined;
        const timeout = setTimeout(() => socket.close(4001, "no access code"), AUTH_TIMEOUT_MS);
        socket.on("message", (raw) => {
            let message: ClientMessage;
            try {
                message = JSON.parse(raw.toString()) as ClientMessage;
            } catch {
                return;
            }
            if (!userId) {
                if (message.type !== "auth" || typeof message.code !== "string") return;
                userId = this.userFor(message.code);
                clearTimeout(timeout);
                if (!userId) {
                    socket.close(4003, "wrong access code");
                    return;
                }
                this.join(userId, socket);
                return;
            }
            if (message.type === "reset") {
                const user = userId;
                void this.startFresh(user).catch((error: unknown) => {
                    console.error(`[app] starting fresh for ${user} failed`, error);
                    this.send(socket, { type: "error", message: "I couldn't start fresh just now. Try again?" });
                });
                return;
            }
            if (message.type === "send") {
                const user = userId;
                void this.handle(user, socket, message).catch((error: unknown) => {
                    console.error(`[app] message from ${user} failed`, error);
                    this.send(socket, { type: "error", message: "That message could not be answered. Try again?" });
                });
            }
        });
        socket.on("close", () => {
            clearTimeout(timeout);
            if (userId) this.sockets.get(userId)?.delete(socket);
        });
    }

    private join(userId: string, socket: WebSocket): void {
        const sockets = this.sockets.get(userId) ?? new Set();
        sockets.add(socket);
        this.sockets.set(userId, sockets);
        this.send(socket, { type: "ready", history: this.log.entries(userId).slice(-HISTORY) });
        if (this.running.get(userId)) this.send(socket, { type: "typing", active: true });
    }

    private async handle(
        userId: string,
        socket: WebSocket,
        message: Extract<ClientMessage, { type: "send" }>,
    ): Promise<void> {
        const text = typeof message.text === "string" ? message.text.trim().slice(0, MAX_TEXT_CHARS) : "";
        const incoming: IncomingFile[] = (message.files ?? []).map((file) => ({
            name: String(file.name || "file"),
            mimeType: String(file.mimeType || "application/octet-stream"),
            data: new Uint8Array(Buffer.from(String(file.data), "base64")),
        }));
        if (!text && !incoming.length) return;
        let files: AppFile[];
        try {
            files = incoming.map((file) => this.log.storeFile(userId, file.name, file.mimeType, file.data));
        } catch {
            this.send(socket, { type: "error", message: "That file is too big for me (over 20 MB)." });
            return;
        }
        const entry = this.log.add(userId, { role: "user", text, files: files.length ? files : undefined });
        this.broadcast(userId, { type: "ack", clientId: String(message.clientId), entry });

        this.running.set(userId, (this.running.get(userId) ?? 0) + 1);
        this.broadcast(userId, { type: "typing", active: true });
        try {
            const reply = await this.orchestrator.send(userId, text, {
                files: incoming,
                onProgress: (progress) =>
                    this.broadcast(
                        userId,
                        progress.type === "text"
                            ? { type: "delta", text: progress.delta }
                            : { type: "tool", name: progress.name },
                    ),
                react: async (emoji) => {
                    this.log.react(userId, entry.id, emoji);
                    this.broadcast(userId, { type: "reaction", entryId: entry.id, emoji });
                    return true;
                },
                sendFile: async (file: OutgoingFile) => {
                    const stored = this.log.storeFile(userId, file.name, file.mimeType, file.data);
                    const sent = this.log.add(userId, { role: "assistant", text: "", files: [stored] });
                    this.broadcast(userId, { type: "entry", entry: sent });
                },
            });
            // Empty when a reaction was the whole answer.
            if (reply) {
                this.broadcast(userId, {
                    type: "entry",
                    entry: this.log.add(userId, { role: "assistant", text: reply }),
                });
            }
        } finally {
            const left = (this.running.get(userId) ?? 1) - 1;
            this.running.set(userId, left);
            this.broadcast(userId, { type: "typing", active: left > 0 });
        }
    }

    private async startFresh(userId: string): Promise<void> {
        await this.orchestrator.startFresh(userId);
        this.log.clear(userId);
        this.broadcast(userId, { type: "ready", history: [] });
    }

    private broadcast(userId: string, message: ServerMessage): void {
        for (const socket of this.sockets.get(userId) ?? []) this.send(socket, message);
    }

    private send(socket: WebSocket, message: ServerMessage): void {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    }
}

/** Where a phone on the same network finds this machine. */
const localAddresses = (port: number): string[] =>
    Object.values(networkInterfaces())
        .flat()
        .filter((address) => address && address.family === "IPv4" && !address.internal)
        .map((address) => `http://${address?.address}:${port}`);

/** Starts the app server and says how to pair a phone with it. `others` serves the paths outside `/app/`. */
export const startAppChannel = (
    orchestrator: AppAnswerer,
    app: AppConfig,
    dataDir: string,
    others?: RequestListener,
) => {
    const codesFile = join(dataDir, "app-codes.json");
    const { codes, created } = loadOrCreateAppCodes(codesFile, app.users);
    const channel = new AppChannel(orchestrator, codes, new AppLog(join(dataDir, "app")));
    const server = channel.createServer(others);
    server.listen(app.port);
    const addresses = localAddresses(app.port);
    console.log(`Phone app on ${addresses[0] ?? `http://localhost:${app.port}`}`);
    for (const userId of created) console.log(`  New access code for ${userId}: ${codes.get(userId)}`);
    if (created.length < app.users.length) console.log(`  Access codes are in ${codesFile}`);
    return { channel, server };
};
