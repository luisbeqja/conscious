import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { renderSVG } from "uqr";
import { type ChatLinks, MAC_OFFERS_PATH } from "../protocol.js";
import { listFolders, realFolder } from "./folders.js";
import type { MacLink } from "./link.js";
import { page } from "./page.js";
import { type MacSettings, PERMISSION_MODES, readSettings, writeSettings } from "./settings.js";

/** Where the page is: http://localhost:7337. */
export const PAGE_PORT = 7337;
const COOKIE = "conscious_mac";
const MAX_BODY_BYTES = 8_192;
/** How often a Mac showing a QR asks Conscious whether its code was sent. */
const COLLECT_EVERY_MS = 2_000;

/** The key that opens the page, beside the settings and readable by this user alone. */
export const pageKey = (settingsFile: string): string => {
    const file = join(dirname(settingsFile), "mac-page.key");
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const key = randomBytes(24).toString("base64url");
    writeFileSync(file, key, { mode: 0o600 });
    return key;
};

/** The macOS folder chooser, in front of every window. Undefined when the user cancels. */
export const chooseFolder = (): Promise<string | undefined> =>
    new Promise((resolve, reject) => {
        execFile(
            "osascript",
            ["-e", "activate", "-e", 'POSIX path of (choose folder with prompt "A folder Claude Code may work in")'],
            (error, stdout, stderr) => {
                if (!error) return resolve(stdout.trim() || undefined);
                // -128 is the user pressing Cancel.
                if (/-128/.test(stderr)) return resolve(undefined);
                reject(new Error(`The folder chooser did not open: ${stderr.trim() || error.message}`));
            },
        );
    });

export interface PageOptions {
    /** The settings file. */
    file: string;
    link: MacLink;
    port?: number;
    /** How the Mac is called in the chat, for a new link. */
    name: () => string;
    findClaude: () => string | undefined;
    claudeVersion: (claude: string) => string | undefined;
    log: string;
    chooseFolder?: () => Promise<string | undefined>;
    /** Stops conscious-mac for good, after the page has answered. */
    stop?: () => void;
    /** How often a QR's code is checked; tests shorten it. */
    collectEveryMs?: number;
}

/** A QR the Mac is showing, until the owner sends its code from their chat. */
interface Linking {
    server: string;
    code: string;
    secret: string;
    links: ChatLinks;
    expiresAt: number;
    error?: string;
    timer?: NodeJS.Timeout;
}

class Refusal extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

const readBody = (request: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                request.destroy();
                reject(new Refusal(413, "Too long."));
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => {
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
                resolve(typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {});
            } catch {
                reject(new Refusal(400, "Send JSON."));
            }
        });
        request.on("error", reject);
    });

const string = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** Conscious's address as typed: https, or http on this computer for a local one. */
const serverAddress = (typed: string): string => {
    let url: URL;
    try {
        url = new URL(/^https?:\/\//.test(typed) ? typed : `https://${typed}`);
    } catch {
        throw new Refusal(400, "That is not an address. It looks like https://conscious.example.com.");
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !local) throw new Refusal(400, "Conscious's address must start with https://");
    return url.origin;
};

/**
 * The page on http://localhost:7337, served by conscious-mac itself: a QR that links the Mac,
 * then its folders, its permission mode, the model and what Claude Code did lately. Only this
 * computer can reach it, and only a browser that opened it with `pnpm mac`, which hands over a
 * key from a file only this user can read: another website cannot change a setting.
 */
export class MacPage {
    private linking?: Linking;
    private readonly key: string;
    private port: number;
    private claude?: { path: string; version?: string };

    constructor(private readonly options: PageOptions) {
        this.key = pageKey(options.file);
        this.port = options.port ?? PAGE_PORT;
    }

    listen(): Promise<Server> {
        const server = createServer((request, response) => {
            this.serve(request, response).catch((error: unknown) => {
                const status = error instanceof Refusal ? error.status : 500;
                const message = error instanceof Error ? error.message : String(error);
                if (!response.headersSent) this.json(response, status, { error: message });
            });
        });
        return new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(this.port, "127.0.0.1", () => {
                this.port = (server.address() as AddressInfo).port;
                resolve(server);
            });
        });
    }

    /** The address `pnpm mac` opens: it hands the browser the key, once. */
    openUrl(): string {
        return `http://localhost:${this.port}/open?key=${this.key}`;
    }

    private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const url = new URL(request.url ?? "/", "http://localhost");
        // A website that renames itself to 127.0.0.1 (DNS rebinding) still sends its own Host.
        const host = request.headers.host ?? "";
        if (host !== `localhost:${this.port}` && host !== `127.0.0.1:${this.port}`) {
            throw new Refusal(403, "This page is only for this computer.");
        }
        if (url.pathname === "/health") return this.json(response, 200, { ok: true, app: "conscious-mac" });
        if (url.pathname === "/open") {
            if (!this.matches(url.searchParams.get("key") ?? "")) throw new Refusal(403, "That key is wrong.");
            response
                .writeHead(302, {
                    location: "/",
                    "set-cookie": `${COOKIE}=${this.key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
                    "cache-control": "no-store",
                })
                .end();
            return;
        }
        if (!this.matches(this.cookie(request))) {
            response
                .writeHead(401, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
                .end("Open this page with `pnpm mac`, run in the Conscious folder on this Mac.");
            return;
        }
        if (request.method === "GET" && url.pathname === "/") return this.showPage(response);
        if (request.method === "GET" && url.pathname === "/api/state") return this.json(response, 200, this.state());
        if (request.method !== "POST" || !url.pathname.startsWith("/api/")) throw new Refusal(404, "Not here.");
        // Only the page itself changes settings, never another site in the same browser.
        const origin = request.headers.origin;
        if (origin !== `http://localhost:${this.port}` && origin !== `http://127.0.0.1:${this.port}`) {
            throw new Refusal(403, "Only this page can change the settings.");
        }
        const body = await readBody(request);
        await this.act(url.pathname.slice("/api/".length), body, response);
        if (!response.headersSent) this.json(response, 200, this.state());
    }

    private async act(action: string, body: Record<string, unknown>, response: ServerResponse): Promise<void> {
        const settings = readSettings(this.options.file);
        const update = (change: Partial<MacSettings>) => {
            if (!settings) throw new Refusal(409, "Link this Mac first.");
            writeSettings(this.options.file, { ...settings, ...change });
        };
        const addFolder = (path: string) => {
            const folder = realFolder(path);
            if (!folder) throw new Refusal(400, `${path} is not a folder on this Mac.`);
            update({ folders: [...new Set([...(settings?.folders ?? []), folder])] });
        };
        switch (action) {
            case "link":
                return this.startLinking(serverAddress(string(body.server)));
            case "link/cancel":
                return this.stopLinking();
            case "unlink":
                this.options.link.unlink();
                return update({ token: "" });
            case "folders/add": {
                const path = string(body.path);
                if (!path) throw new Refusal(400, "Type a folder's path, like ~/Projects/site.");
                return addFolder(path);
            }
            case "folders/pick": {
                const chosen = await (this.options.chooseFolder ?? chooseFolder)();
                return chosen ? addFolder(chosen) : undefined;
            }
            case "folders/home":
                return addFolder(homedir());
            case "folders/remove":
                return update({ folders: (settings?.folders ?? []).filter((folder) => folder !== string(body.path)) });
            case "settings": {
                const mode = string(body.permissionMode);
                if (mode && !PERMISSION_MODES.includes(mode)) throw new Refusal(400, "That is not a permission mode.");
                const model = "model" in body ? string(body.model) : undefined;
                if (model && !/^[\w.-]{1,60}$/.test(model)) throw new Refusal(400, "That is not a model name.");
                return update({
                    ...(mode ? { permissionMode: mode } : {}),
                    ...(model !== undefined ? { model: model || undefined } : {}),
                });
            }
            case "stop":
                this.json(response, 200, { stopped: true });
                setTimeout(() => this.options.stop?.(), 300);
                return;
            default:
                throw new Refusal(404, "Not here.");
        }
    }

    /** Asks Conscious for a code to show as a QR, then asks every two seconds whether it was sent. */
    private async startLinking(server: string): Promise<void> {
        this.stopLinking();
        const response = await fetch(new URL(MAC_OFFERS_PATH, server), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: this.options.name() }),
        }).catch((error: unknown) => {
            throw new Refusal(502, `Could not reach ${server}: ${error instanceof Error ? error.message : error}`);
        });
        if (response.status === 404) {
            throw new Refusal(502, `${server} does not link Macs: set CONSCIOUS_MAC=true there, and update it.`);
        }
        const offer = (await response.json().catch(() => ({}))) as {
            code?: string;
            secret?: string;
            expiresAt?: string;
            links?: ChatLinks;
        };
        if (!response.ok || !offer.code || !offer.secret)
            throw new Refusal(502, `${server} answered ${response.status}.`);
        const linking: Linking = {
            server,
            code: offer.code,
            secret: offer.secret,
            links: offer.links ?? {},
            expiresAt: new Date(offer.expiresAt ?? Date.now() + 10 * 60_000).getTime(),
        };
        this.linking = linking;
        linking.timer = setInterval(() => void this.collect(linking), this.options.collectEveryMs ?? COLLECT_EVERY_MS);
    }

    private async collect(linking: Linking): Promise<void> {
        if (this.linking !== linking) return;
        if (Date.now() > linking.expiresAt) {
            clearInterval(linking.timer);
            linking.error = "This code expired. Cancel, and show a new one.";
            return;
        }
        const response = await fetch(new URL(`${MAC_OFFERS_PATH}/collect`, linking.server), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: linking.code, secret: linking.secret }),
        }).catch(() => undefined);
        // Offline for a moment: the next try may get through.
        if (!response || response.status === 202 || this.linking !== linking) return;
        const result = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
        clearInterval(linking.timer);
        if (!result.token) {
            linking.error = result.error ?? `Conscious answered ${response.status}.`;
            return;
        }
        const before = readSettings(this.options.file);
        writeSettings(this.options.file, {
            server: linking.server,
            token: result.token,
            name: this.options.name(),
            folders: before?.folders ?? [],
            claude: before?.claude || this.options.findClaude() || "claude",
            permissionMode: before?.permissionMode ?? "acceptEdits",
            model: before?.model,
        });
        this.linking = undefined;
    }

    private stopLinking(): void {
        clearInterval(this.linking?.timer);
        this.linking = undefined;
    }

    private state() {
        const settings = readSettings(this.options.file);
        const claude = settings?.claude || this.options.findClaude() || "";
        if (this.claude?.path !== claude) {
            this.claude = { path: claude, version: claude ? this.options.claudeVersion(claude) : undefined };
        }
        const { linking } = this;
        return {
            name: settings?.name || this.options.name(),
            server: settings?.server ?? "",
            linked: Boolean(settings?.token),
            state: this.options.link.state,
            linking: linking && {
                code: linking.code,
                expiresAt: linking.expiresAt,
                error: linking.error,
                qr: Object.fromEntries(
                    Object.entries(linking.links)
                        .filter(([, link]) => typeof link === "string" && /^https:\/\//.test(link))
                        .map(([chat, link]) => [chat, renderSVG(link as string, { border: 2 })]),
                ),
            },
            folders: listFolders(settings?.folders ?? []),
            home: realFolder(homedir()) ?? homedir(),
            permissionMode: settings?.permissionMode ?? "acceptEdits",
            model: settings?.model ?? "",
            claude: this.claude,
            activity: this.options.link.activity(),
            log: this.options.log,
        };
    }

    private showPage(response: ServerResponse): void {
        const nonce = randomBytes(16).toString("base64");
        response
            .writeHead(200, {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
                "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
                "x-frame-options": "DENY",
                "referrer-policy": "no-referrer",
            })
            .end(page(nonce));
    }

    private json(response: ServerResponse, status: number, body: unknown): void {
        response
            .writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
            .end(JSON.stringify(body));
    }

    private cookie(request: IncomingMessage): string {
        const cookies = request.headers.cookie ?? "";
        return /(?:^|;\s*)conscious_mac=([^;]+)/.exec(cookies)?.[1] ?? "";
    }

    private matches(given: string): boolean {
        const a = Buffer.from(given);
        const b = Buffer.from(this.key);
        return a.length === b.length && timingSafeEqual(a, b);
    }
}
