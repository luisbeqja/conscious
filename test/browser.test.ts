import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { BrowserProvider, BrowserTab, FoundImage, LiveViewTarget } from "../src/browser/browser.js";
import { clickIsCommit, commitWord, type ElementInfo, typingIsRefused } from "../src/browser/guard.js";
import { LiveViews, relayLiveView, serveLiveView } from "../src/browser/live-view.js";
import { createBrowserCapability } from "../src/capabilities/browser/capability.js";
import type { ToolContext } from "../src/capabilities/types.js";
import { adaptTool } from "../src/engine/tool-adapter.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { FakeSandboxes } from "./fake-sandbox.js";

const element = (overrides: Partial<ElementInfo> = {}): ElementInfo => ({
    tag: "button",
    type: "",
    name: "",
    autocomplete: "",
    fieldHint: "",
    formAsksFor: [],
    submitsForm: false,
    navigates: false,
    ...overrides,
});

describe("the commit guard", () => {
    it("finds the words that pay, book, send or delete, in the users' languages", () => {
        expect(commitWord("Pay now")).toBeDefined();
        expect(commitWord("Pay €612 with card")).toBe("pay");
        expect(commitWord("Prenota ora")).toBeDefined();
        expect(commitWord("Réserver")).toBe("reserver");
        expect(commitWord("Zahlungspflichtig bestellen")).toBeDefined();
        expect(commitWord("Send")).toBe("send");
        expect(commitWord("Elimina account")).toBe("elimina");
    });

    it("leaves alone what only looks like it: cookie banners, filters, carts, checkout pages, other words", () => {
        for (const label of [
            "Accept all cookies",
            "Apply filters",
            "Add to cart",
            "Proceed to checkout",
            "PayPal",
            "Books",
            "Facebook",
            "Ordina per prezzo",
            "Search flights",
        ]) {
            expect(commitWord(label), label).toBeUndefined();
        }
    });

    it("refuses a commit button but lets a link with the same word open its page", () => {
        expect(clickIsCommit(element({ name: "Post" }))).toContain('"post"');
        expect(clickIsCommit(element({ tag: "a", name: "Post office", navigates: true }))).toBeUndefined();
        expect(clickIsCommit(element({ name: "Continue", submitsForm: true, formAsksFor: ["card"] }))).toContain(
            "card details",
        );
        expect(
            clickIsCommit(element({ name: "Log in", submitsForm: true, formAsksFor: ["password"] })),
        ).toBeUndefined();
    });

    it("never types a password or card details", () => {
        expect(typingIsRefused(element({ tag: "input", type: "password" }))).toBe("password");
        expect(typingIsRefused(element({ tag: "input", autocomplete: "current-password" }))).toBe("password");
        expect(typingIsRefused(element({ tag: "input", autocomplete: "cc-number" }))).toBe("card");
        expect(typingIsRefused(element({ tag: "input", fieldHint: "cardNumber card-number" }))).toBe("card");
        expect(typingIsRefused(element({ tag: "input", type: "search", fieldHint: "q" }))).toBeUndefined();
    });
});

/** A tab made of a script: each ref is an element, each step is recorded. */
class FakeTab implements BrowserTab {
    readonly steps: string[] = [];
    address = "about:blank";
    tree = '- button "Search" [ref=e1]';
    constructor(
        private readonly elements: Record<string, ElementInfo> = {},
        private readonly files: Record<string, { bytes: Uint8Array; contentType: string }> = {},
    ) {}
    async goto(url: string) {
        this.address = url;
        this.steps.push(`goto ${url}`);
    }
    url() {
        return this.address;
    }
    async title() {
        return "A page";
    }
    async snapshot() {
        this.steps.push("snapshot");
        return this.tree;
    }
    async inspect(ref: string) {
        const found = this.elements[ref];
        if (!found) throw new Error(`no ${ref}`);
        return found;
    }
    async click(ref: string) {
        this.steps.push(`click ${ref}`);
    }
    async type(ref: string, text: string, submit: boolean) {
        this.steps.push(`type ${ref} ${text}${submit ? " ⏎" : ""}`);
    }
    async press(key: string) {
        this.steps.push(`press ${key}`);
    }
    async scroll(direction: "up" | "down") {
        this.steps.push(`scroll ${direction}`);
    }
    async back() {
        this.steps.push("back");
    }
    async screenshot() {
        return new Uint8Array([0xff, 0xd8, 0xff]);
    }
    async images(): Promise<FoundImage[]> {
        return [
            { src: "https://shop.example/small.jpg", alt: "", width: 100, height: 100 },
            { src: "https://shop.example/big.jpg", alt: "The tram", width: 1200, height: 800 },
        ];
    }
    async download(url: string) {
        const file = this.files[url];
        if (!file) throw new Error("404");
        return file;
    }
}

const setUp = (tab: FakeTab, seesImages = true) => {
    const sandboxes = new FakeSandboxes();
    const views = new LiveViews("https://conscious.example", () => 0);
    const target: LiveViewTarget = {
        origin: "https://6080-x.e2b.app",
        headers: { "e2b-traffic-access-token": "t" },
        password: "pw",
    };
    const browsers: BrowserProvider = { forUser: async () => ({ tab: async () => tab, liveView: async () => target }) };
    const capability = createBrowserCapability(browsers, views, sandboxes, () => new Date("2026-10-25T12:00:00Z"));
    const context: ToolContext = {
        userId: "me",
        timezone: "Europe/Rome",
        scheduler: new Scheduler(async () => {}),
        seesImages,
    };
    const tool = (name: string) => {
        const found = capability.tools.find((candidate) => candidate.name === name);
        if (!found) throw new Error(name);
        return found;
    };
    const call = async (name: string, params: Record<string, unknown>) => tool(name).execute(params as never, context);
    return { sandboxes, views, call, tool, context };
};

describe("the browser tools", () => {
    it("opens a page and reads a long one in parts, from the same tree", async () => {
        const tab = new FakeTab();
        tab.tree = "x".repeat(25_000);
        const { call } = setUp(tab);
        const opened = (await call("browser_open_page", { url: "https://example.com" })).data as Record<string, string>;
        expect(opened.page).toHaveLength(10_000);
        expect(opened.more).toContain("from=10000");
        const next = (await call("browser_read_page", { from: 20_000 })).data as Record<string, string>;
        expect(next.page).toHaveLength(5_000);
        expect(next.more).toBeUndefined();
        expect(tab.steps.filter((step) => step === "snapshot")).toHaveLength(1);
        await expect(call("browser_open_page", { url: "example.com" })).rejects.toThrow(/https:/);
    });

    it("clicks what is safe and refuses what would pay, book or send", async () => {
        const tab = new FakeTab({
            e1: element({ name: "Show more flights" }),
            e2: element({ name: "Book now" }),
            e3: element({ name: "Continue", submitsForm: true, formAsksFor: ["card"] }),
        });
        const { call } = setUp(tab);
        await call("browser_click", { ref: "e1" });
        await expect(call("browser_click", { ref: "e2" })).rejects.toThrow(
            /Not done: "Book now" would act for the user/,
        );
        await expect(call("browser_click", { ref: "e3" })).rejects.toThrow(/card details/);
        expect(tab.steps.filter((step) => step.startsWith("click"))).toEqual(["click e1"]);
    });

    it("types and searches, but never a password or a card, and never submits a card form", async () => {
        const tab = new FakeTab({
            e1: element({ tag: "input", type: "search", name: "Where to?" }),
            e2: element({ tag: "input", type: "password" }),
            e3: element({ tag: "input", autocomplete: "cc-number" }),
            e4: element({ tag: "input", name: "Name on card", formAsksFor: ["card"] }),
        });
        const { call } = setUp(tab);
        await call("browser_type", { ref: "e1", text: "Lisbon", submit: true });
        await expect(call("browser_type", { ref: "e2", text: "hunter2" })).rejects.toThrow(/never type a password/);
        await expect(call("browser_type", { ref: "e3", text: "4111" })).rejects.toThrow(/card and bank details/);
        await expect(call("browser_type", { ref: "e4", text: "Luis", submit: true })).rejects.toThrow(/card details/);
        expect(tab.steps.filter((step) => step.startsWith("type"))).toEqual(["type e1 Lisbon ⏎"]);
    });

    it("takes a screenshot the model sees, and keeps it on the user's computer", async () => {
        const { call, tool, context, sandboxes } = setUp(new FakeTab());
        const output = await call("browser_take_screenshot", {});
        expect(output.data).toMatchObject({ saved: "files/browser/20261025120000-screenshot.jpg" });
        expect(
            (await sandboxes.forUser("me")).bytes.has("/home/user/files/browser/20261025120000-screenshot.jpg"),
        ).toBe(true);
        const shown = await adaptTool(tool("browser_take_screenshot"), context).execute("1", {});
        expect(shown.content.map((block) => block.type)).toEqual(["text", "image"]);
        const blind = await adaptTool(tool("browser_take_screenshot"), { ...context, seesImages: false }).execute(
            "2",
            {},
        );
        expect(blind.content.map((block) => block.type)).toEqual(["text"]);
    });

    it("finds pictures biggest first and saves one with the right extension", async () => {
        const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
        const tab = new FakeTab(
            {},
            { "https://shop.example/big": { bytes: jpeg, contentType: "image/jpeg; charset=binary" } },
        );
        const { call } = setUp(tab);
        const images = (await call("browser_find_images", {})).data as FoundImage[];
        expect(images.map((image) => image.src)).toEqual([
            "https://shop.example/big.jpg",
            "https://shop.example/small.jpg",
        ]);
        const saved = await call("browser_save_file", { url: "https://shop.example/big", name: "lisbon tram" });
        expect(saved.data).toMatchObject({ saved: "files/browser/20261025120000-lisbon-tram.jpg", type: "image/jpeg" });
        expect(saved.images?.[0]?.mimeType).toBe("image/jpeg");
    });

    it("asks the user to sign in through a private link to the browser, on the sign-in page", async () => {
        const tab = new FakeTab();
        const { call, views } = setUp(tab);
        const output = await call("browser_ask_user_to_sign_in", {
            url: "https://www.ryanair.com/login",
            site: "Ryanair",
        });
        const link = new URL((output.data as { link: string }).link);
        expect(tab.steps).toContain("goto https://www.ryanair.com/login");
        expect(link.origin).toBe("https://conscious.example");
        const code = /^\/browser\/([\w-]+)\/vnc\.html$/.exec(link.pathname)?.[1] ?? "";
        expect(views.find(code)?.userId).toBe("me");
        expect(link.searchParams.get("path")).toBe(`browser/${code}/websockify`);
        expect(link.searchParams.get("password")).toBe("pw");
        expect(output.guidance).toMatch(/never send it anywhere else/i);
    });
});

describe("the live view relay", () => {
    const servers: Server[] = [];
    afterEach(async () => {
        await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
    });
    const listen = async (server: Server) => {
        servers.push(server);
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        return (server.address() as AddressInfo).port;
    };

    it("serves the page and relays the socket only with a live code, adding the token on the way", async () => {
        // Stands in for the browser computer's noVNC: it answers only callers with the token.
        const seen: string[] = [];
        const remote = createServer((request, response) => {
            seen.push(`${request.url} ${request.headers["e2b-traffic-access-token"]}`);
            if (request.headers["e2b-traffic-access-token"] !== "secret") return response.writeHead(403).end();
            response.writeHead(200, { "content-type": "text/html" }).end("<title>noVNC</title>");
        });
        const echo = new WebSocketServer({ noServer: true });
        remote.on("upgrade", (request, socket, head) => {
            if (request.headers["e2b-traffic-access-token"] !== "secret") return socket.destroy();
            echo.handleUpgrade(request, socket, head, (ws) => ws.on("message", (data) => ws.send(`echo:${data}`)));
        });
        const remotePort = await listen(remote);

        let clock = 0;
        const views = new LiveViews("https://conscious.example", () => clock);
        const serve = serveLiveView(views);
        const relay = relayLiveView(views);
        const front = createServer((request, response) => {
            if (!serve(request, response)) response.writeHead(404).end();
        });
        front.on("upgrade", (request, socket, head) => {
            if (!relay(request, socket, head)) socket.destroy();
        });
        const frontPort = await listen(front);
        const { link } = views.open("me", {
            origin: `http://127.0.0.1:${remotePort}`,
            headers: { "e2b-traffic-access-token": "secret" },
            password: "pw",
        });
        const path = new URL(link).pathname;

        const page = await fetch(`http://127.0.0.1:${frontPort}${path}`);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("noVNC");
        expect(page.headers.get("referrer-policy")).toBe("no-referrer");
        expect(seen).toEqual(["/vnc.html secret"]);

        const socket = new WebSocket(`ws://127.0.0.1:${frontPort}${path.replace("vnc.html", "websockify")}`);
        const reply = await new Promise<string>((resolve, reject) => {
            socket.on("open", () => socket.send("hello"));
            socket.on("message", (data) => resolve(String(data)));
            socket.on("error", reject);
        });
        expect(reply).toBe("echo:hello");
        socket.close();

        expect((await fetch(`http://127.0.0.1:${frontPort}/browser/${"x".repeat(32)}/vnc.html`)).status).toBe(410);
        clock += 16 * 60_000;
        expect((await fetch(`http://127.0.0.1:${frontPort}${path}`)).status).toBe(410);
        expect((await fetch(`http://127.0.0.1:${frontPort}/elsewhere`)).status).toBe(404);
    });

    it("closes the old link when the same user opens a new one", () => {
        const views = new LiveViews("https://conscious.example", () => 0);
        const target = { origin: "https://6080-x.e2b.app", headers: {}, password: "pw" };
        const first = new URL(views.open("me", target).link).pathname.split("/")[2] ?? "";
        const second = new URL(views.open("me", target).link).pathname.split("/")[2] ?? "";
        expect(views.find(first)).toBeUndefined();
        expect(views.find(second)?.userId).toBe("me");
    });
});
