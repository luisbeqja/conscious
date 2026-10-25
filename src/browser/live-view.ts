import { randomBytes } from "node:crypto";
import {
    type ClientRequest,
    request as httpRequest,
    type IncomingMessage,
    type RequestOptions,
    type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import type { LiveViewTarget } from "./browser.js";

const PREFIX = "/browser/";
const LIFETIME_MS = 15 * 60_000;

interface View {
    userId: string;
    target: LiveViewTarget;
    expires: number;
}

/** The code in a live view path and the path inside the browser computer: `/browser/<code>/<rest>`. */
const route = (url = "/"): { code: string; rest: string } | undefined => {
    const match = /^\/browser\/([A-Za-z0-9_-]{24,64})(\/[^?#]*)?(\?[^#]*)?$/.exec(url);
    if (!match?.[1]) return undefined;
    return { code: match[1], rest: `${match[2] || "/vnc.html"}${match[3] ?? ""}` };
};

const PAGE_HEADERS = {
    "cache-control": "no-store",
    // The link carries the view's password: it must never leave in a Referer.
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
};

const GONE =
    "<!doctype html><meta name=viewport content='width=device-width'><title>Link expired</title><p style='font:17px system-ui;margin:2em'>This link has expired. Ask Conscious for a new one.</p>";

/**
 * Private links to watch and use the user's browser, so they can sign in to a site themselves:
 * the agent never sees or types a password. Like a Vault link, the code is the only key; it lasts
 * 15 minutes, and a new link for the same user closes the old one.
 */
export class LiveViews {
    private readonly views = new Map<string, View>();

    constructor(
        private readonly publicUrl: string,
        private readonly now: () => number = Date.now,
    ) {}

    open(userId: string, target: LiveViewTarget): { link: string; expiresAt: Date } {
        for (const [code, view] of this.views) {
            if (view.userId === userId || view.expires <= this.now()) this.views.delete(code);
        }
        const code = randomBytes(24).toString("base64url");
        const expires = this.now() + LIFETIME_MS;
        this.views.set(code, { userId, target, expires });
        const query = new URLSearchParams({
            autoconnect: "true",
            resize: "scale",
            // noVNC opens its socket at this path, which comes back here instead of to E2B.
            path: `browser/${code}/websockify`,
            password: target.password,
        });
        return {
            link: `${this.publicUrl.replace(/\/$/, "")}${PREFIX}${code}/vnc.html?${query}`,
            expiresAt: new Date(expires),
        };
    }

    find(code: string): View | undefined {
        const view = this.views.get(code);
        if (view && view.expires > this.now()) return view;
        this.views.delete(code);
        return undefined;
    }
}

/**
 * Serves a live view's page and files from the user's browser computer, adding the token only
 * Conscious holds. Returns false for any other path, so the caller can serve it.
 */
export const serveLiveView =
    (views: LiveViews) =>
    (incoming: IncomingMessage, response: ServerResponse): boolean => {
        const where = route(incoming.url);
        if (!where) return false;
        const view = views.find(where.code);
        if (!view) {
            response.writeHead(410, { ...PAGE_HEADERS, "content-type": "text/html; charset=utf-8" }).end(GONE);
            return true;
        }
        if (incoming.method !== "GET" && incoming.method !== "HEAD") {
            response.writeHead(405, PAGE_HEADERS).end();
            return true;
        }
        const upstream = request(
            new URL(where.rest, view.target.origin),
            { method: incoming.method, headers: { ...view.target.headers, accept: incoming.headers.accept ?? "*/*" } },
            (answer) => {
                response.writeHead(answer.statusCode ?? 502, {
                    ...PAGE_HEADERS,
                    "content-type": answer.headers["content-type"] ?? "application/octet-stream",
                });
                answer.pipe(response);
            },
        );
        upstream.on("error", (error) => {
            console.error("[browser] live view page failed", error);
            if (!response.headersSent) response.writeHead(502, PAGE_HEADERS);
            response.end();
        });
        upstream.end();
        return true;
    };

/** E2B serves https; a test serves plain http. */
const request = (url: URL, options: RequestOptions, onAnswer?: (answer: IncomingMessage) => void): ClientRequest =>
    (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, onAnswer);

const FORWARDED = ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"];

/** Relays the live view's socket to the browser computer. Returns false for any other path. */
export const relayLiveView =
    (views: LiveViews) =>
    (incoming: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
        const where = route(incoming.url);
        if (!where) return false;
        const view = views.find(where.code);
        if (!view) {
            socket.end("HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n");
            return true;
        }
        const headers: Record<string, string> = { ...view.target.headers, connection: "Upgrade", upgrade: "websocket" };
        for (const name of FORWARDED) {
            const value = incoming.headers[name];
            if (typeof value === "string") headers[name] = value;
        }
        const upstream = request(new URL(where.rest, view.target.origin), { headers });
        upstream.on("upgrade", (answer, remote, remoteHead) => {
            const lines = ["HTTP/1.1 101 Switching Protocols"];
            for (const [name, value] of Object.entries(answer.headers)) {
                for (const item of Array.isArray(value) ? value : [value ?? ""]) lines.push(`${name}: ${item}`);
            }
            socket.write(`${lines.join("\r\n")}\r\n\r\n`);
            if (remoteHead.length) socket.write(remoteHead);
            if (head.length) remote.write(head);
            remote.pipe(socket).pipe(remote);
            const close = () => {
                socket.destroy();
                remote.destroy();
            };
            for (const end of [socket, remote]) {
                end.on("error", close);
                end.on("close", close);
            }
        });
        upstream.on("response", (answer) => {
            socket.end(
                `HTTP/1.1 ${answer.statusCode ?? 502} ${answer.statusMessage ?? ""}\r\nConnection: close\r\n\r\n`,
            );
        });
        upstream.on("error", (error) => {
            console.error("[browser] live view socket failed", error);
            socket.destroy();
        });
        upstream.end();
        return true;
    };
