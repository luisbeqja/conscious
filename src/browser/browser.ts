import { createHash } from "node:crypto";
import { Sandbox as Desktop } from "@e2b/desktop";
import { type Browser, chromium, type Page } from "playwright-core";
import type { ElementInfo } from "./guard.js";

/** An image on the page, as the agent can pick it. */
export interface FoundImage {
    src: string;
    alt: string;
    width: number;
    height: number;
}

/** The one tab the agent works in. Playwright drives it; tests use a fake. */
export interface BrowserTab {
    goto(url: string): Promise<void>;
    url(): string;
    title(): Promise<string>;
    /** The page as an accessibility tree, each element with a ref like `[ref=e12]`. */
    snapshot(): Promise<string>;
    /** What an element is, read before acting on it. */
    inspect(ref: string): Promise<ElementInfo>;
    click(ref: string): Promise<void>;
    type(ref: string, text: string, submit: boolean): Promise<void>;
    press(key: string): Promise<void>;
    scroll(direction: "up" | "down"): Promise<void>;
    back(): Promise<void>;
    /** A JPEG of the window, or of the page from the top when `fullPage`. */
    screenshot(fullPage: boolean): Promise<Uint8Array>;
    images(): Promise<FoundImage[]>;
    /** Fetches a URL with the browser's cookies, so a file behind a sign-in comes too. */
    download(url: string): Promise<{ bytes: Uint8Array; contentType: string }>;
}

/** Where the live view of the user's browser is, for the server that relays it to their phone. */
export interface LiveViewTarget {
    /** `https://<port>-<sandbox>.e2b.app`, reachable only with `headers`. */
    origin: string;
    headers: Record<string, string>;
    /** The VNC password, new for every live view. */
    password: string;
}

export interface BrowserSession {
    tab(): Promise<BrowserTab>;
    /** Shows the browser's screen, so the user can sign in themselves. */
    liveView(): Promise<LiveViewTarget>;
}

/** One browser per user, kept between jobs with its sign-ins. */
export interface BrowserProvider {
    forUser(userId: string): Promise<BrowserSession>;
}

const STEP_MS = 15_000;
const MAX_SHOT_HEIGHT = 4_000;

/** The Playwright page behind a BrowserTab. */
export class PlaywrightTab implements BrowserTab {
    constructor(private readonly page: Page) {}

    async goto(url: string): Promise<void> {
        await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await this.settle();
    }

    url(): string {
        return this.page.url();
    }

    title(): Promise<string> {
        return this.page.title();
    }

    snapshot(): Promise<string> {
        return this.page.ariaSnapshot({ mode: "ai", timeout: STEP_MS });
    }

    inspect(ref: string): Promise<ElementInfo> {
        // Runs in the page: plain JavaScript, nothing from outside the function.
        return this.page.getByRef(ref).evaluate((element: Element) => {
            const input = element as HTMLInputElement;
            const form = input.form ?? element.closest("form");
            const asks = new Set<"card" | "password">();
            for (const field of form ? Array.from(form.querySelectorAll("input")) : []) {
                const autocomplete = (field.getAttribute("autocomplete") ?? "").toLowerCase();
                const hint = `${field.name} ${field.id} ${autocomplete}`.toLowerCase();
                if (field.type === "password" || autocomplete.includes("password")) asks.add("password");
                if (autocomplete.startsWith("cc-") || /card|cvc|cvv|iban|security.?code/.test(hint)) asks.add("card");
            }
            const tag = element.tagName.toLowerCase();
            const type = (element.getAttribute("type") ?? "").toLowerCase();
            const role = element.getAttribute("role") ?? "";
            return {
                tag,
                type,
                name: (
                    element.getAttribute("aria-label") ||
                    (element as HTMLElement).innerText ||
                    input.value ||
                    element.getAttribute("title") ||
                    ""
                )
                    .trim()
                    .slice(0, 200),
                autocomplete: element.getAttribute("autocomplete") ?? "",
                fieldHint: `${element.getAttribute("name") ?? ""} ${element.id}`,
                formAsksFor: Array.from(asks),
                submitsForm:
                    Boolean(form) &&
                    ((tag === "button" && (type === "" || type === "submit")) ||
                        (tag === "input" && (type === "submit" || type === "image"))),
                navigates: tag === "a" && element.hasAttribute("href") && role !== "button",
            };
        });
    }

    async click(ref: string): Promise<void> {
        await this.page.getByRef(ref).click({ timeout: STEP_MS });
        await this.settle();
    }

    async type(ref: string, text: string, submit: boolean): Promise<void> {
        const field = this.page.getByRef(ref);
        await field.fill(text, { timeout: STEP_MS });
        if (submit) {
            await field.press("Enter", { timeout: STEP_MS });
            await this.settle();
        }
    }

    async press(key: string): Promise<void> {
        await this.page.keyboard.press(key);
        await this.settle();
    }

    async scroll(direction: "up" | "down"): Promise<void> {
        await this.page.mouse.wheel(0, direction === "down" ? 700 : -700);
        await this.page.waitForTimeout(400);
    }

    async back(): Promise<void> {
        await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
        await this.settle();
    }

    async screenshot(fullPage: boolean): Promise<Uint8Array> {
        if (!fullPage) return this.page.screenshot({ type: "jpeg", quality: 70, timeout: STEP_MS });
        const size = this.page.viewportSize() ?? { width: 1024, height: 768 };
        const height = await this.page.evaluate(() => document.documentElement.scrollHeight);
        return this.page.screenshot({
            type: "jpeg",
            quality: 70,
            timeout: STEP_MS,
            fullPage: true,
            clip: { x: 0, y: 0, width: size.width, height: Math.min(height, MAX_SHOT_HEIGHT) },
        });
    }

    images(): Promise<FoundImage[]> {
        return this.page.evaluate(() => {
            const seen = new Set<string>();
            const found: { src: string; alt: string; width: number; height: number }[] = [];
            const add = (src: string, alt: string, width: number, height: number) => {
                if (!src || src.startsWith("data:") || seen.has(src)) return;
                seen.add(src);
                found.push({ src, alt: alt.trim().slice(0, 120), width, height });
            };
            // The picture a page means to be shared comes first: products, articles, places.
            const shared = document.querySelector('meta[property="og:image"]')?.getAttribute("content");
            if (shared) add(new URL(shared, location.href).href, document.title, 0, 0);
            for (const image of Array.from(document.images)) {
                if (image.naturalWidth < 80 || image.naturalHeight < 80) continue;
                add(image.currentSrc || image.src, image.alt, image.naturalWidth, image.naturalHeight);
            }
            return found.slice(0, 40);
        });
    }

    async download(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
        const response = await this.page.request.get(url, { timeout: 30_000 });
        if (!response.ok()) throw new Error(`The site answered ${response.status()} for that file`);
        return { bytes: await response.body(), contentType: response.headers()["content-type"] ?? "" };
    }

    /** Lets a page that keeps loading after its first bytes finish, without waiting forever. */
    private async settle(): Promise<void> {
        await this.page.waitForLoadState("load", { timeout: 5_000 }).catch(() => {});
    }
}

export interface E2BBrowserOptions {
    apiKey: string;
    domain?: string;
    /** An outbound HTTPS proxy, for hosts that cannot reach E2B directly. */
    proxy?: string;
    /** The E2B template with a desktop and Chrome. */
    template: string;
    /** Idle time before the browser's computer pauses. Pausing keeps its tabs and sign-ins. */
    idleMs: number;
}

const CDP_PORT = 9222;
const STREAM_PORT = 6080;
const PROFILE = "/home/user/.config/conscious-browser";
const CHROME = [
    "google-chrome",
    `--remote-debugging-port=${CDP_PORT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-component-update",
    "--start-maximized",
    "about:blank",
].join(" ");
const TOKEN_HEADER = "e2b-traffic-access-token";
// Refresh the computer's idle timer at most this often; reconnect when it may have paused.
const TOUCH_MS = 30_000;
const RECONNECT_MARGIN_MS = 60_000;

const browserKey = (userId: string): string => createHash("sha256").update(userId).digest("hex").slice(0, 32);

/**
 * Each user's browser on an E2B desktop computer of its own, found again after a restart by a
 * hash of their id. Its URLs are private: only Conscious holds the token that opens them, so
 * nobody else can drive the browser or watch it.
 */
export class E2BBrowsers implements BrowserProvider {
    private readonly sessions = new Map<string, E2BBrowserSession>();

    constructor(private readonly options: E2BBrowserOptions) {}

    async forUser(userId: string): Promise<BrowserSession> {
        const session = this.sessions.get(userId) ?? new E2BBrowserSession(this.options, userId);
        this.sessions.set(userId, session);
        return session;
    }
}

class E2BBrowserSession implements BrowserSession {
    private computer?: Promise<Desktop>;
    private usedAt = 0;
    private touchedAt = 0;
    private browser?: Browser;
    private page?: Page;

    constructor(
        private readonly options: E2BBrowserOptions,
        private readonly userId: string,
    ) {}

    async tab(): Promise<BrowserTab> {
        return new PlaywrightTab(await this.connect());
    }

    async liveView(): Promise<LiveViewTarget> {
        const desktop = await this.desktop();
        // A view started by an earlier run of Conscious has a password nobody knows any more: start over.
        await desktop.commands.run("pkill x11vnc; pkill -f novnc_proxy; true").catch(() => undefined);
        await desktop.stream.start({ requireAuth: true });
        return {
            origin: `https://${desktop.getHost(STREAM_PORT)}`,
            headers: { [TOKEN_HEADER]: desktop.trafficAccessToken ?? "" },
            password: desktop.stream.getAuthKey(),
        };
    }

    private async connect(): Promise<Page> {
        const desktop = await this.desktop();
        if (this.browser?.isConnected() && this.page && !this.page.isClosed()) return this.page;
        await this.ensureChrome(desktop);
        const host = desktop.getHost(CDP_PORT);
        const headers = { [TOKEN_HEADER]: desktop.trafficAccessToken ?? "" };
        // Chrome names its socket after the host it was asked for, which E2B masks as localhost: keep the path.
        const version = (await (await fetch(`https://${host}/json/version`, { headers })).json()) as {
            webSocketDebuggerUrl: string;
        };
        const socket = `wss://${host}${new URL(version.webSocketDebuggerUrl).pathname}`;
        this.browser = await chromium.connectOverCDP(socket, { headers, timeout: 30_000 });
        const context = this.browser.contexts()[0] ?? (await this.browser.newContext());
        this.page =
            context.pages().find((page) => !page.url().startsWith("chrome://")) ??
            context.pages()[0] ??
            (await context.newPage());
        return this.page;
    }

    /** The user's browser computer: kept, resumed if it paused, or made the first time. */
    private async desktop(): Promise<Desktop> {
        const now = Date.now();
        const fresh = this.computer && now - this.usedAt < this.options.idleMs - RECONNECT_MARGIN_MS;
        if (!fresh) {
            this.computer = this.attach();
            this.browser = undefined;
            this.page = undefined;
        }
        this.usedAt = now;
        const computer = this.computer as Promise<Desktop>;
        try {
            const desktop = await computer;
            if (fresh && now - this.touchedAt > TOUCH_MS) {
                this.touchedAt = now;
                await desktop.setTimeout(this.options.idleMs);
            }
            return desktop;
        } catch (error) {
            if (this.computer === computer) this.computer = undefined;
            throw error;
        }
    }

    private async attach(): Promise<Desktop> {
        const { apiKey, domain, proxy, template, idleMs } = this.options;
        const connection = { apiKey, domain, proxy };
        const metadata = { "conscious-browser": browserKey(this.userId) };
        const [found] = await Desktop.list({ ...connection, query: { metadata }, limit: 1 }).nextItems();
        this.touchedAt = Date.now();
        // Connecting resumes a paused computer, with Chrome and its tabs as they were.
        if (found) return Desktop.connect(found.sandboxId, { ...connection, timeoutMs: idleMs });
        return Desktop.create(template, {
            ...connection,
            metadata,
            timeoutMs: idleMs,
            lifecycle: { onTimeout: "pause" },
            // Private URLs, and Chrome told its callers are local so it accepts remote control.
            // biome-ignore lint/suspicious/noTemplateCurlyInString: E2B fills in ${PORT} itself.
            network: { allowPublicTraffic: false, maskRequestHost: "localhost:${PORT}" },
            envs: {},
        });
    }

    private async ensureChrome(desktop: Desktop): Promise<void> {
        const running = await desktop.commands.run(
            `curl -s -o /dev/null -w '%{http_code}' localhost:${CDP_PORT}/json/version || true`,
        );
        if (running.stdout.trim() === "200") return;
        await desktop.commands.run(`${CHROME} >/tmp/chrome.log 2>&1`, {
            background: true,
            envs: { DISPLAY: desktop.display },
        });
        for (let attempt = 0; attempt < 30; attempt++) {
            const probe = await desktop.commands.run(
                `curl -s -o /dev/null -w '%{http_code}' localhost:${CDP_PORT}/json/version || true`,
            );
            if (probe.stdout.trim() === "200") return;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw new Error("The browser did not start");
    }
}
