import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { GoogleSignInExpired } from "../google/oauth.js";
import { authHeader, type Connector } from "../plugins/connectors.js";
import type { Vault } from "./vault.js";

/** Whether a secret works, asked of the service itself before the Vault keeps it. */
export type VerifySecret = (connector: Connector, secret: string) => Promise<boolean>;

export const verifyWithService: VerifySecret = async (connector, secret) => {
    const response = await fetch(connector.verifyUrl, {
        headers: { ...authHeader(secret, connector.header), accept: "application/json", "user-agent": "Conscious" },
        signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
};

export interface VaultServerOptions {
    vault: Vault;
    verify: VerifySecret;
    /** Called once a secret is saved, to tell the user in the chat. */
    onConnected: (userId: string, connector: Connector) => Promise<void>;
    /** Sign-in by redirect, for connectors that have it. */
    signIn?: SignInProvider;
}

/** A provider the user signs in to on its own page. It comes back to `callbackPath` with a code. */
export interface SignInProvider {
    callbackPath: string;
    authUrl(state: string): string;
    /** The refresh token the Vault keeps. */
    exchange(code: string): Promise<string>;
}

const MAX_BODY_BYTES = 8_192;

const HEADERS = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
};

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)} · Conscious Vault</title>
<style>
:root{color-scheme:light dark;--fg:#1a1a1a;--muted:#666;--bg:#fafaf7;--card:#fff;--line:#e4e2dc;--accent:#2f6f4f;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--muted:#aaa;--bg:#141414;--card:#1e1e1e;--line:#333;--accent:#6fbf8f;--bad:#f2b8b5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:440px;margin:0 auto;padding:32px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px}
h1{font-size:20px;margin:0 0 4px}p,li{color:var(--muted)}ol{padding-left:20px}
a{color:var(--accent)}label{display:block;font-weight:600;margin:16px 0 6px}
input{width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--fg);font:inherit}
button,.button{display:block;text-align:center;text-decoration:none;margin-top:14px;width:100%;padding:12px;border:0;border-radius:10px;background:var(--accent);color:#fff;font:inherit;font-weight:600}
.bad{color:var(--bad)}.note{font-size:13px;margin-top:16px}
.warn{border-left:3px solid var(--bad);padding-left:10px}.hosts b{color:var(--fg);font-weight:600}
</style></head><body><main><div class="card">${body}</div></main></body></html>`;

const signInPage = (connector: Connector, code: string, error?: string) =>
    page(
        `Connect ${connector.name}`,
        `<h1>Connect ${escapeHtml(connector.name)}</h1>
<p>You sign in on Google's own page. Conscious never sees your password; it keeps an encrypted sign-in that you can remove at any time.</p>
<ol>${connector.howTo.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
${error ? `<p class="bad">${escapeHtml(error)}</p>` : ""}
<p><a class="button" href="/vault/${escapeHtml(code)}/start">Sign in with Google</a></p>
<p class="note">This link works once and expires in 15 minutes.</p>`,
    );

const form = (connector: Connector, error?: string) =>
    page(
        `Connect ${connector.name}`,
        `<h1>Connect ${escapeHtml(connector.name)}</h1>
<p>Conscious will use this to act as your ${escapeHtml(connector.name)} account. It is stored encrypted and never shown in the chat.</p>
${
    connector.agentDefined
        ? `<p class="warn">Conscious wrote this connection itself; nobody else has checked it. Continue only if these addresses belong to ${escapeHtml(connector.name)}.</p>`
        : ""
}
<ol>${connector.howTo.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
<p><a href="${escapeHtml(connector.howTo.url)}" target="_blank" rel="noopener noreferrer">Open ${escapeHtml(connector.name)}</a></p>
<form method="post" autocomplete="off">
<p class="hosts">Your token will only be sent to: ${connector.hosts.map((host) => `<b>${escapeHtml(host)}</b>`).join(", ")}</p>
<label for="secret">Token</label>
<input id="secret" name="secret" type="password" required autocomplete="off" spellcheck="false">
${error ? `<p class="bad">${escapeHtml(error)}</p>` : ""}
<button type="submit">Save to the Vault</button>
</form>
<p class="note">This link works once and expires in 15 minutes.</p>`,
    );

const gone = () =>
    page("Link expired", "<h1>This link has expired</h1><p>Ask Conscious in the chat for a new one.</p>");

const saved = (connector: Connector) =>
    page(
        "Saved",
        `<h1>${escapeHtml(connector.name)} is connected</h1><p>You can close this page and go back to the chat.</p>`,
    );

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
 * The Vault page: `GET /vault/<code>` shows a form for one secret, `POST` saves it. The code in
 * the link, sent to the user in their own chat, is the only thing that grants access.
 */
export const createVaultServer = (options: VaultServerOptions): Server =>
    createServer(async (request: IncomingMessage, response: ServerResponse) => {
        const send = (status: number, html: string) => response.writeHead(status, HEADERS).end(html);
        const url = new URL(request.url ?? "/", "http://vault");
        if (options.signIn && url.pathname === options.signIn.callbackPath) {
            return signInCallback(options, options.signIn, url, send);
        }
        const match = /^\/vault\/([A-Za-z0-9_-]{16,64})(\/start)?$/.exec(url.pathname);
        if (!match?.[1]) return send(404, gone());
        const code = match[1];
        const link = options.vault.findLink(code);
        if (!link) return send(410, gone());
        const { connector } = link;

        if (connector.signIn) {
            if (!options.signIn || request.method !== "GET") return send(404, gone());
            if (!match[2]) return send(200, signInPage(connector, code));
            // The link's code travels as OAuth state, so the callback knows whose sign-in it is.
            return response.writeHead(302, { ...HEADERS, location: options.signIn.authUrl(code) }).end();
        }
        if (match[2]) return send(404, gone());
        if (request.method === "GET") return send(200, form(connector));
        if (request.method !== "POST") return send(405, gone());

        const body = await readBody(request);
        const secret = new URLSearchParams(body ?? "").get("secret")?.trim();
        if (!secret) return send(400, form(connector, "Paste the token first."));
        let works = false;
        try {
            works = await options.verify(connector, secret);
        } catch {
            return send(502, form(connector, `Could not reach ${connector.name} to check it. Try again.`));
        }
        if (!works) {
            options.vault.failAttempt(code);
            return send(400, form(connector, `${connector.name} did not accept that token. Check it and try again.`));
        }
        await save(options, link.userId, connector, secret, code, send);
    });

const save = async (
    options: VaultServerOptions,
    userId: string,
    connector: Connector,
    secret: string,
    code: string,
    send: (status: number, html: string) => void,
) => {
    options.vault.set(userId, connector, secret);
    options.vault.consumeLink(code);
    send(200, saved(connector));
    await options.onConnected(userId, connector).catch((error: unknown) => {
        console.error("[vault] could not tell the user", error);
    });
};

/** Where the provider sends the user back. `state` is the Vault link's code, so it is single-use too. */
const signInCallback = async (
    options: VaultServerOptions,
    signIn: SignInProvider,
    url: URL,
    send: (status: number, html: string) => void,
) => {
    const state = url.searchParams.get("state") ?? "";
    const link = /^[A-Za-z0-9_-]{16,64}$/.test(state) ? options.vault.findLink(state) : undefined;
    if (!link?.connector.signIn) return send(410, gone());
    const code = url.searchParams.get("code");
    if (!code) {
        options.vault.failAttempt(state);
        return send(400, signInPage(link.connector, state, "Google did not sign you in. Try again."));
    }
    let refreshToken: string;
    try {
        refreshToken = await signIn.exchange(code);
    } catch (error) {
        options.vault.failAttempt(state);
        const message = error instanceof GoogleSignInExpired ? "That sign-in expired." : (error as Error).message;
        return send(400, signInPage(link.connector, state, `${message} Try again.`));
    }
    await save(options, link.userId, link.connector, refreshToken, state, send);
};
