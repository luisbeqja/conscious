import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createMacCapability } from "../src/capabilities/mac/capability.js";
import type { ToolContext } from "../src/capabilities/types.js";
import { macCommands } from "../src/mac/commands.js";
import { MacLinks } from "../src/mac/links.js";
import { runClaude } from "../src/mac/local/claude.js";
import { resolveFolder } from "../src/mac/local/folders.js";
import { type LinkEnd, MacLink } from "../src/mac/local/link.js";
import { type MacSettings, readSettings, writeSettings } from "../src/mac/local/settings.js";
import { MacPage } from "../src/mac/local/ui.js";
import { CLOSE, type FromMac, MAC_SOCKET_PATH, type ToMac } from "../src/mac/protocol.js";
import { MacBridge } from "../src/mac/server.js";
import type { Scheduler } from "../src/scheduler/scheduler.js";

const OWNER = "+393330000000";
const SESSION = "0b0b0b0b-1111-2222-3333-444444444444";

/** A stand-in for Claude Code: it reads the message and prints what the real one would, as JSON lines. */
const FAKE_CLAUDE = `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
    const args = process.argv.slice(2);
    const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
    const session = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : "${SESSION}";
    say({ type: "system", subtype: "init", session_id: session });
    say({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } });
    const finish = () =>
        say({
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: session,
            num_turns: 2,
            total_cost_usd: 0.01,
            result: JSON.stringify({ input, args, cwd: process.cwd() }),
            permission_denials: input.includes("push") ? [{ tool_name: "Bash", tool_input: { command: "git push" } }] : [],
        });
    if (input.includes("slow")) setTimeout(finish, 30000);
    else finish();
});
process.on("SIGINT", () => process.exit(130));
`;

const temporary = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

const fakeClaude = (): string => {
    const path = join(temporary("claude-"), "claude");
    writeFileSync(path, FAKE_CLAUDE);
    chmodSync(path, 0o755);
    return path;
};

const until = async (check: () => boolean, ms = 5_000) => {
    const started = Date.now();
    while (!check()) {
        if (Date.now() - started > ms) throw new Error("timed out waiting");
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
};

const servers: Server[] = [];
const stops: AbortController[] = [];
afterEach(() => {
    for (const stop of stops.splice(0)) stop.abort();
    for (const server of servers.splice(0)) server.close();
});

/** Conscious's side on a real port: the pairing page and the Macs' socket, as the Vault's server serves them. */
const serve = async (links = new MacLinks()) => {
    const linked: string[] = [];
    const bridge = new MacBridge(links, {
        onLinked: (userId, name, folders) =>
            linked.push(`${userId} ${name} ${folders.map((folder) => folder.name).join(",")}`),
    });
    const server = createServer((request, response) => {
        if (!bridge.serve(request, response)) response.writeHead(404).end();
    });
    server.on("upgrade", (request, socket, head) => {
        if (!bridge.upgrade(request, socket, head)) socket.destroy();
    });
    server.on("close", () => bridge.close());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { links, bridge, url, linked };
};

const pairOver = async (url: string, code: string) => {
    const response = await fetch(`${url}/mac/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, name: "Luis's MacBook" }),
    });
    return { status: response.status, body: (await response.json()) as { token?: string; error?: string } };
};

/** A Mac linked to `url` with one allowed folder, running conscious-mac with the stand-in Claude Code. */
const startMac = (url: string, token: string, extra: Partial<MacSettings> = {}) => {
    const project = join(temporary("projects-"), "project");
    mkdirSync(project);
    const file = join(temporary("mac-"), "mac.json");
    writeSettings(file, {
        server: url,
        token,
        name: "Luis's MacBook",
        folders: [project],
        claude: fakeClaude(),
        permissionMode: "acceptEdits",
        ...extra,
    });
    const stop = new AbortController();
    stops.push(stop);
    const ended = new MacLink(file, { log: () => {}, caffeinate: false }).run(stop.signal);
    return { project, file, stop, ended };
};

describe("Mac links", () => {
    it("trade a code for a token once, within 15 minutes, and find the Mac by its token", () => {
        let now = new Date("2026-10-29T10:00:00Z");
        const links = new MacLinks(undefined, () => now);
        const late = links.startPairing(OWNER);
        now = new Date(now.getTime() + 16 * 60_000);
        expect(links.pair(late.code, "Mac")).toBeUndefined();

        const pairing = links.startPairing(OWNER);
        expect(pairing.code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
        // Typed without dashes, in capitals, it still works; but only once.
        const paired = links.pair(pairing.code.replaceAll("-", "").toUpperCase(), "Luis's MacBook");
        expect(paired?.userId).toBe(OWNER);
        expect(links.pair(pairing.code, "Another")).toBeUndefined();
        expect(links.macFor(paired?.token ?? "")).toMatchObject({ userId: OWNER, name: "Luis's MacBook" });
        expect(links.macFor("not-a-token")).toBeUndefined();
    });

    it("link a new Mac in place of the old one, forget it, and keep the token's digest only", () => {
        const file = join(temporary("macs-"), "macs.json");
        const links = new MacLinks(file);
        const first = links.pair(links.startPairing(OWNER).code, "Old Mac");
        const second = links.pair(links.startPairing(OWNER).code, "New Mac");

        const reopened = new MacLinks(file);
        expect(reopened.macFor(first?.token ?? "")).toBeUndefined();
        expect(reopened.macFor(second?.token ?? "")?.name).toBe("New Mac");
        expect(JSON.stringify(reopened)).not.toContain(second?.token);
        expect(reopened.forget(OWNER)).toBe(true);
        expect(reopened.linked(OWNER)).toBeUndefined();
        expect(reopened.forget(OWNER)).toBe(false);
    });
});

describe("Claude Code on the Mac, through the link", () => {
    it("pairs once, then runs Claude Code in an allowed folder and brings back its answer", async () => {
        const { links, bridge, url, linked } = await serve();
        const { code } = links.startPairing(OWNER);
        const paired = await pairOver(url, code);
        expect(paired.status).toBe(200);
        expect((await pairOver(url, code)).status).toBe(403);

        const mac = startMac(url, paired.body.token ?? "");
        await until(() => bridge.status(OWNER)?.online === true);
        expect(linked).toEqual([`${OWNER} Luis's MacBook project`]);
        expect(bridge.status(OWNER)?.folders).toEqual([{ name: "project", path: mac.project }]);

        const answer = await bridge.ask(OWNER, { folder: "project", message: "What is in here?" });
        const ran = JSON.parse(answer.text) as { input: string; args: string[]; cwd: string };
        expect(ran.input).toBe("What is in here?");
        expect(ran.cwd).toBe(mac.project);
        // Nobody is at the Mac: whatever would prompt is refused, never waited on.
        expect(ran.args.join(" ")).toContain("--permission-prompts none --permission-mode acceptEdits");
        expect(answer).toMatchObject({ session: SESSION, folder: mac.project, denied: [], error: false, turns: 2 });

        const again = await bridge.ask(OWNER, {
            folder: mac.project,
            message: "Only tell me",
            session: SESSION,
            readOnly: true,
        });
        expect((JSON.parse(again.text) as { args: string[] }).args.join(" ")).toContain(
            `--permission-mode plan --append-system-prompt`,
        );
        expect((JSON.parse(again.text) as { args: string[] }).args.slice(-2)).toEqual(["--resume", SESSION]);

        const refused = await bridge.ask(OWNER, { folder: "project", message: "Commit and push" });
        expect(refused.denied).toEqual(["Bash: git push"]);
        // One conversation so far: each job went on with it, and it is still known by what it was first asked.
        expect(bridge.status(OWNER)?.conversations).toEqual([
            { folder: "project", session: SESSION, about: "What is in here?", minutesAgo: 0 },
        ]);
    });

    it("refuses a folder that is not allowed, a path that only looks inside, and a session that is a flag", async () => {
        const { links, bridge, url } = await serve();
        const paired = links.pair(links.startPairing(OWNER).code, "Mac");
        const mac = startMac(url, paired?.token ?? "");
        await until(() => bridge.status(OWNER)?.online === true);

        await expect(bridge.ask(OWNER, { folder: "Documents", message: "hi" })).rejects.toThrow(
            /"Documents" is not a folder Claude Code may use on this Mac\. Allowed: project/,
        );
        await expect(bridge.ask(OWNER, { folder: `${mac.project}/../..`, message: "hi" })).rejects.toThrow(
            /is not a folder/,
        );
        await expect(
            bridge.ask(OWNER, { folder: "project", message: "hi", session: "--dangerously-skip-permissions" }),
        ).rejects.toThrow(/not a Claude Code session id/);
    });

    it("shows Claude Code's steps while it works, and stops it when the job is given up", async () => {
        const { links, bridge, url } = await serve();
        const paired = links.pair(links.startPairing(OWNER).code, "Mac");
        startMac(url, paired?.token ?? "");
        await until(() => bridge.status(OWNER)?.online === true);

        const stop = new AbortController();
        const working = bridge.ask(OWNER, { folder: "project", message: "a slow job" }, stop.signal);
        await until(() => bridge.status(OWNER)?.working[0]?.lastSteps.length === 1);
        expect(bridge.status(OWNER)?.working[0]).toMatchObject({ folder: "project", lastSteps: ["Bash: npm test"] });
        stop.abort(new Error("it ran out of time"));
        await expect(working).rejects.toThrow("it ran out of time");
        expect(bridge.status(OWNER)?.working).toEqual([]);
        // A job given up before it starts is never sent.
        await expect(bridge.ask(OWNER, { folder: "project", message: "hi" }, stop.signal)).rejects.toThrow(
            "it ran out of time",
        );
        expect(bridge.status(OWNER)?.working).toEqual([]);
    });

    it("says the Mac is offline, and tells a Mac that was unlinked to stop", async () => {
        const { links, bridge, url } = await serve();
        await expect(bridge.ask(OWNER, { folder: "project", message: "hi" })).rejects.toThrow(/No Mac is linked/);
        const paired = links.pair(links.startPairing(OWNER).code, "Mac");
        await expect(bridge.ask(OWNER, { folder: "project", message: "hi" })).rejects.toThrow(/The Mac is offline/);

        const stranger = startMac(url, "a token nobody gave out");
        expect(await stranger.ended).toBe<LinkEnd>("unlinked");

        const mac = startMac(url, paired?.token ?? "");
        await until(() => bridge.status(OWNER)?.online === true);
        bridge.disconnect(OWNER);
        links.forget(OWNER);
        expect(await mac.ended).toBe<LinkEnd>("unlinked");
    });

    it("gives a job again to a Mac that drops off and comes back, which answers it once", async () => {
        const { links, bridge, url } = await serve();
        const paired = links.pair(links.startPairing(OWNER).code, "Mac");
        const socketUrl = `${url.replace("http", "ws")}${MAC_SOCKET_PATH}`;
        const connect = async () => {
            const socket = new WebSocket(socketUrl);
            const received: ToMac[] = [];
            socket.on("message", (raw) => received.push(JSON.parse(raw.toString()) as ToMac));
            await new Promise((resolve) => socket.on("open", resolve));
            const hello: FromMac = { type: "hello", token: paired?.token ?? "", name: "Mac", version: 1, folders: [] };
            socket.send(JSON.stringify(hello));
            return { socket, received };
        };

        const first = await connect();
        await until(() => bridge.status(OWNER)?.online === true);
        const answered = bridge.ask(OWNER, { folder: "project", message: "hi" });
        await until(() => first.received.some((message) => message.type === "ask"));
        const asked = first.received.find((message) => message.type === "ask");
        first.socket.close();
        await until(() => bridge.status(OWNER)?.online === false);

        const second = await connect();
        await until(() => second.received.some((message) => message.type === "ask"));
        expect(second.received.find((message) => message.type === "ask")).toEqual(asked);
        const id = asked?.type === "ask" ? asked.id : "";
        const reply: FromMac = {
            type: "answer",
            id,
            answer: { session: SESSION, folder: "/p", text: "done", error: false, denied: [], turns: 1 },
        };
        second.socket.send(JSON.stringify(reply));
        await expect(answered).resolves.toMatchObject({ text: "done" });

        // A third connection takes over, and the one before is told so.
        const closed = new Promise<number>((resolve) => second.socket.on("close", resolve));
        const third = await connect();
        expect(await closed).toBe(CLOSE.replaced);
        third.socket.close();
    });
});

describe("allowed folders", () => {
    it("are found by name or by a path inside, never through a link that leads outside", () => {
        const root = temporary("folders-");
        const project = join(root, "project");
        const outside = join(root, "outside");
        mkdirSync(join(project, "src"), { recursive: true });
        mkdirSync(outside);
        symlinkSync(outside, join(project, "escape"));

        expect(resolveFolder("project", [project])).toBe(project);
        expect(resolveFolder(join(project, "src"), [project])).toBe(join(project, "src"));
        expect(resolveFolder(outside, [project])).toBeUndefined();
        expect(resolveFolder(join(project, "escape"), [project])).toBeUndefined();
        expect(resolveFolder("src", [project])).toBeUndefined();
    });

    it("read ~ as the home folder, which, once allowed, opens every path inside it", () => {
        const home = realpathSync(homedir());
        expect(resolveFolder("~", [home])).toBe(home);
        expect(resolveFolder("~/..", [home])).toBeUndefined();
        expect(resolveFolder("~", [temporary("elsewhere-")])).toBeUndefined();
    });

    it("refuse a session id that would pass as a flag before Claude Code starts", async () => {
        const { answer } = runClaude({
            claude: "/bin/false",
            folder: tmpdir(),
            message: "hi",
            session: "--dangerously-skip-permissions",
            permissionMode: "acceptEdits",
            caffeinate: false,
        });
        await expect(answer).rejects.toThrow(/not a Claude Code session id/);
    });
});

describe("the mac capability", () => {
    const context = (): ToolContext => ({ userId: OWNER, timezone: "Europe/Rome", scheduler: {} as Scheduler });

    it("is offered once a Mac is linked, and asks Claude Code only from a background task", async () => {
        const links = new MacLinks();
        const bridge = new MacBridge(links);
        const capability = createMacCapability(bridge);
        expect(await capability.available?.(OWNER)).toBe(false);
        links.pair(links.startPairing(OWNER).code, "Mac");
        expect(await capability.available?.(OWNER)).toBe(true);

        const ask = capability.tools.find((tool) => tool.name === "mac_ask_claude_code");
        // The chat hands it to a background task rather than wait minutes on it.
        expect(ask?.backgroundOnly).toBe(true);
        // In a background task it goes to the Mac, which is offline here.
        await expect(ask?.execute({ folder: "project", message: "hi" }, context())).rejects.toThrow(/offline/);
        const status = capability.tools.find((tool) => tool.name === "mac_check_status");
        expect((await status?.execute({}, context()))?.data).toEqual({
            name: "Mac",
            online: false,
            folders: [],
            working: [],
            conversations: [],
        });
        bridge.close();
    });
});

describe("/mac", () => {
    const setup = () => {
        const links = new MacLinks();
        const bridge = new MacBridge(links);
        const command = macCommands({
            links,
            bridge,
            publicUrl: "https://conscious.example.com/",
            isOwner: (userId) => userId === OWNER,
        });
        return { links, bridge, command };
    };

    it("is for the owner, gives the line to run on the Mac, and unlinks with /mac off", () => {
        const { links, bridge, command } = setup();
        expect(command(OWNER, "hello")).toBeUndefined();
        expect(command("+39444", "/mac")).toBe("Only the owner of this Conscious can link a Mac.");

        const reply = command(OWNER, "/mac") ?? "";
        const code = /pnpm mac pair https:\/\/conscious\.example\.com (\S+)/.exec(reply)?.[1] ?? "";
        expect(links.pair(code, "Luis's MacBook")?.userId).toBe(OWNER);
        expect(command(OWNER, "/mac")).toBe(
            "Luis's MacBook is linked, and offline right now. /mac new links another Mac in its place, /mac off unlinks it.",
        );
        expect(command(OWNER, "/mac new")).toContain("pnpm mac pair");
        expect(command(OWNER, "/mac off")).toContain("Luis's MacBook is unlinked");
        expect(links.linked(OWNER)).toBeUndefined();
        expect(command(OWNER, "/mac off")).toBe("No Mac is linked, so there is nothing to unlink.");
        bridge.close();
    });
});

/** A request with the headers a browser would send, or a site pretending. */
const call = (
    port: number,
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const body = options.body === undefined ? undefined : JSON.stringify(options.body);
        const sent = httpRequest(
            {
                host: "127.0.0.1",
                port,
                path,
                method: options.method ?? "GET",
                headers: {
                    host: `localhost:${port}`,
                    ...(body ? { "content-type": "application/json" } : {}),
                    ...options.headers,
                },
            },
            (response) => {
                let data = "";
                response.on("data", (chunk) => {
                    data += chunk;
                });
                response.on("end", () =>
                    resolve({ status: response.statusCode ?? 0, headers: response.headers, body: data }),
                );
            },
        );
        sent.on("error", reject);
        sent.end(body);
    });

/** conscious-mac in the background with its page, not linked yet, and a browser that opened it with `pnpm mac`. */
const openPage = async () => {
    const file = join(temporary("mac-"), "mac.json");
    const link = new MacLink(file, { log: () => {}, caffeinate: false });
    const stop = new AbortController();
    stops.push(stop);
    void link.stayLinked(stop.signal);
    const chosen: string[] = [];
    const macPage = new MacPage({
        file,
        link,
        port: 0,
        name: () => "Luis's MacBook",
        findClaude: fakeClaude,
        claudeVersion: () => "2.1.308 (Claude Code)",
        log: "/tmp/conscious-mac.log",
        chooseFolder: async () => chosen.shift(),
        collectEveryMs: 50,
    });
    const server = await macPage.listen();
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const opened = await call(port, `/open?${new URL(macPage.openUrl()).searchParams}`);
    const cookie = opened.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
    const api = async (path: string, body?: unknown) => {
        const response = await call(port, path, {
            method: body === undefined ? "GET" : "POST",
            headers: { cookie, origin: `http://localhost:${port}` },
            body,
        });
        // biome-ignore lint/suspicious/noExplicitAny: the page's state, read as JSON
        return { status: response.status, data: JSON.parse(response.body) as any };
    };
    return { file, link, port, cookie, api, chosen };
};

describe("linking a Mac with a QR", () => {
    it("gives a code once its secret's owner collects it, after the owner sent it from their chat", () => {
        let now = new Date("2026-10-30T10:00:00Z");
        const links = new MacLinks(undefined, () => now);
        const offer = links.offer("Luis's MacBook");
        expect(links.collect(offer.code, "not the secret")).toBeUndefined();
        expect(links.collect(offer.code, offer.secret)).toBe("waiting");
        expect(links.claim(offer.code.replaceAll("-", ""), OWNER)).toBe("Luis's MacBook");
        // Sent by someone else afterwards, it stays the owner's.
        expect(links.claim(offer.code, "+39444")).toBeUndefined();
        const collected = links.collect(offer.code, offer.secret);
        expect(collected).toMatchObject({ userId: OWNER });
        expect(links.macFor(typeof collected === "object" ? collected.token : "")?.name).toBe("Luis's MacBook");
        expect(links.collect(offer.code, offer.secret)).toBeUndefined();

        const late = links.offer("Mac");
        now = new Date(now.getTime() + 11 * 60_000);
        expect(links.claim(late.code, OWNER)).toBeUndefined();
    });

    it("keeps a QR's code through a restart of Conscious", () => {
        const file = join(temporary("macs-"), "macs.json");
        const offer = new MacLinks(file).offer("Luis's MacBook");
        expect(new MacLinks(file).claim(offer.code, OWNER)).toBe("Luis's MacBook");
        expect(new MacLinks(file).collect(offer.code, offer.secret)).toMatchObject({ userId: OWNER });
    });

    it("waits out a restart of Conscious on the page, and shows a fresh code for one it lost", async () => {
        // A Conscious that restarts: 502 for a moment, then it no longer knows the first code.
        const codes = ["aaaa-bbbb-cccc", "dddd-eeee-ffff"];
        const replies = [502, 502, 410];
        let shown = 0;
        const conscious = createServer((request, response) => {
            let body = "";
            request.on("data", (chunk) => {
                body += chunk;
            });
            request.on("end", () => {
                const send = (status: number, json: object) =>
                    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
                if (request.url === "/mac/offers") {
                    return send(200, {
                        code: codes[shown++],
                        secret: "s",
                        expiresAt: new Date(Date.now() + 600_000).toISOString(),
                        links: { telegram: "https://t.me/conscious_bot?start=mac-x" },
                    });
                }
                const { code } = JSON.parse(body) as { code: string };
                if (code === codes[0]) return send(replies.shift() ?? 410, { error: "This code expired." });
                send(200, { token: "the-token" });
            });
        });
        await new Promise<void>((resolve) => conscious.listen(0, "127.0.0.1", resolve));
        servers.push(conscious);
        const url = `http://127.0.0.1:${(conscious.address() as AddressInfo).port}`;
        const mac = await openPage();
        expect((await mac.api("/api/link", { server: url })).data.linking.code).toBe(codes[0]);
        await until(() => readSettings(mac.file)?.token === "the-token");
        expect(shown).toBe(2);
        expect(replies).toEqual([]);
    });

    it("answers /start mac-<code> from the QR and /mac <code> typed, for the owner only", () => {
        const links = new MacLinks();
        const bridge = new MacBridge(links);
        const command = macCommands({ links, bridge, publicUrl: "https://c.example", isOwner: (id) => id === OWNER });
        const offer = links.offer("Luis's MacBook");
        expect(command("+39444", `/start mac-${offer.code}`)).toBe("Only the owner of this Conscious can link a Mac.");
        expect(command(OWNER, `/start mac-${offer.code}`)).toBe(
            "Linking Luis's MacBook… it connects in a few seconds.",
        );
        expect(command(OWNER, "/mac k7qd-m2xa-9wfe")).toBe(
            "That code doesn't work any more. Your Mac's page shows a new one in a few seconds: scan that one.",
        );
        expect(command(OWNER, "/mac stauts")).toBe(
            "Send /mac to link your Mac, /mac new for another one, /mac off to unlink it.",
        );
        expect(command(OWNER, "/start inv-k7qdm2xa9w")).toBeUndefined();
        bridge.close();
    });

    it("links from the page: a QR to scan, then the Mac connects by itself", async () => {
        const { links, bridge, url, linked } = await serve();
        bridge.chatLinks = (code) => ({ telegram: `https://t.me/conscious_bot?start=mac-${code}` });
        const mac = await openPage();
        expect((await mac.api("/api/state")).data).toMatchObject({ linked: false, name: "Luis's MacBook" });

        const shown = (await mac.api("/api/link", { server: url })).data.linking;
        expect(shown.qr.telegram).toContain("<svg");
        expect(shown.code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);

        // The owner scans it, and Telegram sends the bot /start with the code.
        const command = macCommands({ links, bridge, publicUrl: url, isOwner: (id) => id === OWNER });
        expect(command(OWNER, `/start mac-${shown.code}`)).toBe(
            "Linking Luis's MacBook… it connects in a few seconds.",
        );
        await until(() => bridge.status(OWNER)?.online === true);
        expect(linked).toEqual([`${OWNER} Luis's MacBook `]);
        expect((await mac.api("/api/state")).data).toMatchObject({ linked: true, state: "online", server: url });
        expect(readSettings(mac.file)).toMatchObject({
            server: url,
            name: "Luis's MacBook",
            permissionMode: "acceptEdits",
        });
    });

    it("changes every setting from the page, and unlinks this Mac from Conscious too", async () => {
        const { links, bridge, url } = await serve();
        const paired = links.pair(links.startPairing(OWNER).code, "Mac");
        const mac = await openPage();
        writeSettings(mac.file, {
            server: url,
            token: paired?.token ?? "",
            name: "Mac",
            folders: [],
            claude: "claude",
            permissionMode: "acceptEdits",
        });
        await until(() => bridge.status(OWNER)?.online === true);

        const project = temporary("project-");
        expect((await mac.api("/api/folders/add", { path: project })).data.folders).toEqual([
            { name: basename(project), path: project },
        ]);
        // Conscious sees the new folder without a restart.
        await until(() => bridge.status(OWNER)?.folders.length === 1);
        mac.chosen.push(temporary("picked-"));
        expect((await mac.api("/api/folders/pick", {})).data.folders).toHaveLength(2);
        expect((await mac.api("/api/folders/remove", { path: project })).data.folders).toHaveLength(1);
        expect((await mac.api("/api/folders/add", { path: "/no/such/folder" })).status).toBe(400);

        expect(
            (await mac.api("/api/settings", { permissionMode: "bypassPermissions", model: "haiku" })).data,
        ).toMatchObject({ permissionMode: "bypassPermissions", model: "haiku" });
        expect((await mac.api("/api/settings", { permissionMode: "yolo" })).status).toBe(400);
        expect((await mac.api("/api/settings", { model: "" })).data.model).toBe("");
        expect(readSettings(mac.file)?.permissionMode).toBe("bypassPermissions");
        expect(readSettings(mac.file)?.model).toBeUndefined();

        expect((await mac.api("/api/unlink", {})).data.linked).toBe(false);
        await until(() => links.linked(OWNER) === undefined);
        await until(() => mac.link.state === "unlinked");
    });

    it("opens only for this computer's browser, with the key pnpm mac hands it", async () => {
        const mac = await openPage();
        expect((await call(mac.port, "/")).status).toBe(401);
        expect((await call(mac.port, "/open?key=wrong")).status).toBe(403);
        const shown = await call(mac.port, "/", { headers: { cookie: mac.cookie } });
        expect(shown.status).toBe(200);
        expect(shown.headers["content-security-policy"]).toMatch(/script-src 'nonce-/);
        // A site that points its own name at this computer still sends its own Host.
        const rebound = await call(mac.port, "/api/state", {
            headers: { cookie: mac.cookie, host: "evil.example:7337" },
        });
        expect(rebound.status).toBe(403);
        // Another site in the same browser cannot change a setting, even with the cookie.
        const forged = await call(mac.port, "/api/settings", {
            method: "POST",
            headers: { cookie: mac.cookie, origin: "https://evil.example" },
            body: { permissionMode: "bypassPermissions" },
        });
        expect(forged.status).toBe(403);
        expect(JSON.parse((await call(mac.port, "/health")).body)).toEqual({ ok: true, app: "conscious-mac" });
    });

    it("serves the offers over HTTP: waiting, then the token once", async () => {
        const { links, url } = await serve();
        const post = async (path: string, body: unknown) => {
            const response = await fetch(`${url}${path}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });
            return { status: response.status, body: (await response.json()) as Record<string, string> };
        };
        const offer = (await post("/mac/offers", { name: "Mac" })).body;
        expect(offer).toMatchObject({ links: {} });
        expect((await post("/mac/offers/collect", { code: offer.code, secret: "wrong" })).status).toBe(410);
        expect((await post("/mac/offers/collect", { code: offer.code, secret: offer.secret })).status).toBe(202);
        links.claim(offer.code ?? "", OWNER);
        const collected = await post("/mac/offers/collect", { code: offer.code, secret: offer.secret });
        expect(collected.status).toBe(200);
        expect(links.macFor(collected.body.token ?? "")?.userId).toBe(OWNER);
        expect((await post("/mac/offers/collect", { code: offer.code, secret: offer.secret })).status).toBe(410);
    });
});
