import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createMacCapability } from "../src/capabilities/mac/capability.js";
import type { ToolContext } from "../src/capabilities/types.js";
import { macCommands } from "../src/mac/commands.js";
import { MacLinks } from "../src/mac/links.js";
import { runClaude } from "../src/mac/local/claude.js";
import { resolveFolder } from "../src/mac/local/folders.js";
import { type LinkEnd, MacLink } from "../src/mac/local/link.js";
import { type MacSettings, writeSettings } from "../src/mac/local/settings.js";
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
