import type { Effect } from "../capabilities/types.js";
import { authHeader, type Credential } from "./connectors.js";
import type { FixtureResponse } from "./manifest.js";

export interface PluginHttpRequest {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    /** Sent as JSON unless it is already a string. */
    body?: unknown;
}

export interface PluginHttpResponse {
    status: number;
    headers: Record<string, string>;
    /** Parsed JSON when the response is JSON, text otherwise. */
    body: unknown;
}

/** Performs a request the broker already allowed. Real network in production, fixtures in review. */
export type Transport = (
    request: Required<Omit<PluginHttpRequest, "body">> & { body?: string },
) => Promise<PluginHttpResponse>;

export interface BrokerPolicy {
    hosts: readonly string[];
    /** The calling tool's effect. A `read` tool may only GET. */
    effect: Effect;
    /** The user's token for the plugin's connector, added here so the plugin never holds it. */
    credential?: Credential;
    transport: Transport;
}

export interface BrokeredRequest {
    method: string;
    url: string;
    allowed: boolean;
    reason?: string;
}

/** Plugin-set headers that could carry or replace a credential. */
const STRIPPED_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "host"]);
const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * The only way a plugin reaches the network. It checks every request against what the
 * manifest declared and records it, so a breach is visible even if the plugin swallows the error.
 */
export class Broker {
    readonly log: BrokeredRequest[] = [];

    constructor(private readonly policy: BrokerPolicy) {}

    get violations(): BrokeredRequest[] {
        return this.log.filter((entry) => !entry.allowed);
    }

    request = async (request: PluginHttpRequest): Promise<PluginHttpResponse> => {
        const method = (request.method ?? "GET").toUpperCase();
        const refusal = this.check(method, request.url);
        this.log.push({ method, url: String(request.url), allowed: !refusal, reason: refusal });
        if (refusal) throw new Error(`Request refused: ${refusal}`);

        const headers: Record<string, string> = { accept: "application/json" };
        for (const [name, value] of Object.entries(request.headers ?? {})) {
            if (!STRIPPED_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = String(value);
        }
        const { credential } = this.policy;
        if (credential?.hosts.includes(new URL(request.url).hostname)) {
            Object.assign(headers, authHeader(credential.token, credential.header));
        }
        let body: string | undefined;
        if (request.body !== undefined) {
            body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
            headers["content-type"] ??= "application/json";
        }
        return this.policy.transport({ method, url: request.url, headers, body });
    };

    private check(method: string, rawUrl: string): string | undefined {
        let url: URL;
        try {
            url = new URL(rawUrl);
        } catch {
            return `"${rawUrl}" is not a URL`;
        }
        if (url.protocol !== "https:") return "only https is allowed";
        if ([url.username, url.password, url.port].some(Boolean)) return "URLs may not carry credentials or a port";
        if (!this.policy.hosts.includes(url.hostname)) {
            return `${url.hostname} is not in the plugin's declared hosts (${this.policy.hosts.join(", ")})`;
        }
        if (this.policy.effect === "read" && !READ_METHODS.has(method)) {
            return `a read tool may only GET, not ${method}`;
        }
        return undefined;
    }
}

const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** The real network. Redirects come back to the plugin, so each hop is checked again. */
export const fetchTransport: Transport = async (request) => {
    const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error("Response too large");
    const isJson = response.headers.get("content-type")?.includes("json");
    return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: isJson && text ? JSON.parse(text) : text,
    };
};

/** Replays a plugin test's recorded responses. A request nobody recorded fails the test. */
export const fixtureTransport =
    (responses: readonly FixtureResponse[]): Transport =>
    async (request) => {
        const url = new URL(request.url);
        const key = `${request.method} ${url.origin}${url.pathname}`;
        const match = responses.find((response) => response.match === key);
        if (!match) throw new Error(`No recorded response for ${key}`);
        return { status: match.status, headers: { "content-type": "application/json" }, body: match.body };
    };
