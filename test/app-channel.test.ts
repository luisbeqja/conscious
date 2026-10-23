import { mkdtempSync } from "node:fs";
import type { RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { AppChannel, loadOrCreateAppCodes, type ServerMessage } from "../src/channels/app.js";
import { AppLog } from "../src/channels/app-log.js";
import type { SendOptions } from "../src/engine/orchestrator.js";

const servers: { close: () => void }[] = [];
afterEach(() => {
    for (const server of servers.splice(0)) server.close();
});

const start = async (
    answer: (text: string, options: SendOptions) => Promise<string>,
    others?: RequestListener,
    startFresh: (userId: string) => Promise<void> = async () => {},
) => {
    const dir = mkdtempSync(join(tmpdir(), "conscious-app-"));
    const log = new AppLog(join(dir, "app"));
    const channel = new AppChannel(
        { send: (_userId, text, options) => answer(text, options), startFresh },
        new Map([["me", "abcd-efgh"]]),
        log,
    );
    const server = channel.createServer(others);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    return { channel, log, port, url: `ws://localhost:${port}/app/socket` };
};

/** A phone: connects, keeps every message, and waits for one of a type. */
const phone = async (url: string, code: string) => {
    const socket = new WebSocket(url);
    const received: ServerMessage[] = [];
    const waiters: (() => void)[] = [];
    socket.on("message", (raw) => {
        received.push(JSON.parse(raw.toString()) as ServerMessage);
        for (const wake of waiters.splice(0)) wake();
    });
    await new Promise((resolve) => socket.once("open", resolve));
    socket.send(JSON.stringify({ type: "auth", code }));
    const waitFor = async <T extends ServerMessage["type"]>(type: T, after = 0) => {
        for (;;) {
            const found = received.slice(after).find((message) => message.type === type);
            if (found) return found as Extract<ServerMessage, { type: T }>;
            await new Promise<void>((resolve) => waiters.push(resolve));
        }
    };
    return { socket, received, waitFor };
};

describe("AppChannel", () => {
    it("streams the answer, then saves both sides of the chat", async () => {
        const { url, log } = await start(async (text, options) => {
            options.onProgress?.({ type: "tool", name: "web_search" });
            options.onProgress?.({ type: "text", delta: "Sunny " });
            await options.react?.("👍");
            return `Sunny for ${text}`;
        });
        const app = await phone(url, "ABCD-EFGH ");
        expect((await app.waitFor("ready")).history).toEqual([]);

        app.socket.send(JSON.stringify({ type: "send", clientId: "c1", text: "Rome" }));
        const ack = await app.waitFor("ack");
        expect(ack.clientId).toBe("c1");
        const reply = await app.waitFor("entry");

        expect(reply.entry.text).toBe("Sunny for Rome");
        expect(app.received.map((message) => message.type)).toEqual(
            ["ready", "ack", "typing", "tool", "delta", "reaction", "entry", "typing"].slice(0, app.received.length),
        );
        expect(log.entries("me").map((entry) => [entry.role, entry.text, entry.reaction])).toEqual([
            ["user", "Rome", "👍"],
            ["assistant", "Sunny for Rome", undefined],
        ]);
        app.socket.close();
    });

    it("starts fresh: Conscious forgets the user and every open phone shows an empty chat", async () => {
        const forgotten: string[] = [];
        const { url, log } = await start(
            async (text) => `hi ${text}`,
            undefined,
            async (userId) => void forgotten.push(userId),
        );
        const app = await phone(url, "abcd-efgh");
        await app.waitFor("ready");
        app.socket.send(JSON.stringify({ type: "send", clientId: "c1", text: "Lu" }));
        await app.waitFor("entry");
        const other = await phone(url, "abcd-efgh");
        expect((await other.waitFor("ready")).history).toHaveLength(2);

        const before = other.received.length;
        app.socket.send(JSON.stringify({ type: "reset" }));
        expect((await other.waitFor("ready", before)).history).toEqual([]);
        expect(forgotten).toEqual(["me"]);
        expect(log.entries("me")).toEqual([]);
        app.socket.close();
        other.socket.close();
    });

    it("closes a socket with a wrong code", async () => {
        const { url } = await start(async () => "");
        const socket = new WebSocket(url);
        await new Promise((resolve) => socket.once("open", resolve));
        socket.send(JSON.stringify({ type: "auth", code: "nope" }));
        const code = await new Promise<number>((resolve) => socket.once("close", (closeCode) => resolve(closeCode)));
        expect(code).toBe(4003);
    });

    it("keeps a notification for when the app opens, and serves files only to their owner", async () => {
        const { channel, log, port, url } = await start(async () => "");
        await channel.notify("me", "Time to leave for the airport");
        const file = log.storeFile("me", "ticket.pdf", "application/pdf", new Uint8Array([1, 2, 3]));

        const app = await phone(url, "abcd-efgh");
        expect((await app.waitFor("ready")).history.map((entry) => entry.text)).toEqual([
            "Time to leave for the airport",
        ]);
        app.socket.close();

        const owner = await fetch(`http://localhost:${port}/app/files/${file.id}`, {
            headers: { authorization: "Bearer abcd-efgh" },
        });
        expect(owner.status).toBe(200);
        expect([...new Uint8Array(await owner.arrayBuffer())]).toEqual([1, 2, 3]);
        const stranger = await fetch(`http://localhost:${port}/app/files/${file.id}`);
        expect(stranger.status).toBe(404);
    });

    it("shares its port: paths outside /app/ go to the other handler, the app keeps its own", async () => {
        const { port, url } = await start(
            async () => "",
            (request, response) => response.writeHead(200).end(`vault ${request.url}`),
        );
        expect(await (await fetch(`http://localhost:${port}/vault/abc`)).text()).toBe("vault /vault/abc");
        expect(await (await fetch(`http://localhost:${port}/app/health`)).json()).toEqual({ ok: true });

        const app = await phone(url, "abcd-efgh");
        expect((await app.waitFor("ready")).history).toEqual([]);
        app.socket.close();
    });

    it("creates a code once per user and keeps it", () => {
        const file = join(mkdtempSync(join(tmpdir(), "conscious-codes-")), "codes.json");
        const first = loadOrCreateAppCodes(file, ["me"]);
        const second = loadOrCreateAppCodes(file, ["me", "+39333"]);
        expect(first.created).toEqual(["me"]);
        expect(second.created).toEqual(["+39333"]);
        expect(second.codes.get("me")).toBe(first.codes.get("me"));
        expect(first.codes.get("me")).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    });

    it("sends notifications where the user last wrote", async () => {
        const { channel, log } = await start(async () => "");
        expect(channel.wroteHereSince("me", undefined)).toBe(false);
        log.add("me", { role: "user", text: "hi", at: new Date("2026-10-22T10:00:00Z") });
        expect(channel.wroteHereSince("me", new Date("2026-10-22T09:00:00Z"))).toBe(true);
        expect(channel.wroteHereSince("me", new Date("2026-10-22T11:00:00Z"))).toBe(false);
    });
});
