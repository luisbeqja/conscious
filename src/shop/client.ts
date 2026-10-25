/**
 * Shop MCP (shop.dev): Shopify's catalog of products from millions of stores, checkout at each
 * store, and the user's own Shop account. Its server speaks MCP 2026-07-28, which has no session and
 * no `initialize` (so the SDK's client cannot reach it): every call is one POST that names its own
 * protocol version.
 */
export const SHOP_URL = "https://mcp.shop.com/";
const PROTOCOL = "2026-07-28";
const CALL_TIMEOUT_MS = 60_000;

/** A Shop document: what a tool returns, and what an update sends back. */
export type ShopDocument = Record<string, unknown>;

/** The call needs the user's Shop account: they never signed in, or Shop no longer takes the sign-in. */
export class ShopUnauthorized extends Error {}

/** Shop could not do it. Its own code and wait, and a page where the user can carry on, when it gave them. */
export class ShopError extends Error {
    constructor(
        message: string,
        readonly code?: string,
        readonly retryAfter?: number,
        readonly continueUrl?: string,
    ) {
        super(message);
    }
}

interface RpcResponse {
    error?: { code: number; message: string };
    result?: {
        isError?: boolean;
        structuredContent?: ShopDocument;
        content?: { type: string; text?: string }[];
        _meta?: Record<string, unknown>;
    };
}

/** The JSON-RPC answer, sent as JSON or as the data of one event in a stream. */
const parseAnswer = (text: string, contentType: string): RpcResponse => {
    if (!contentType.includes("text/event-stream")) return JSON.parse(text) as RpcResponse;
    const events = text
        .split(/\r?\n\r?\n/)
        .map((event) =>
            event
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n"),
        )
        .filter(Boolean);
    for (const data of events.reverse()) {
        const message = JSON.parse(data) as RpcResponse;
        if (message.result || message.error) return message;
    }
    throw new ShopError("Shop sent no answer");
};

const textOf = (content: { type: string; text?: string }[] = []): string =>
    content.flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("\n");

export class ShopClient {
    constructor(private readonly doFetch: typeof fetch = fetch) {}

    /**
     * One tool call, as the user when there is a token. Returns the tool's document, also when Shop
     * answered with an error inside it (a product not found, a checkout problem): its messages say
     * what went wrong. Throws when Shop could not answer at all.
     */
    async call(
        name: string,
        args: ShopDocument,
        options: { token?: string; signal?: AbortSignal } = {},
    ): Promise<ShopDocument> {
        const response = await this.doFetch(SHOP_URL, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                "mcp-protocol-version": PROTOCOL,
                "mcp-method": "tools/call",
                "mcp-name": name,
                // Only in this header and only to Shop: never in the arguments.
                ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                    name,
                    arguments: args,
                    _meta: {
                        "io.modelcontextprotocol/protocolVersion": PROTOCOL,
                        "io.modelcontextprotocol/clientInfo": { name: "conscious", version: "0.1.0" },
                        "io.modelcontextprotocol/clientCapabilities": {},
                    },
                },
            }),
            signal: AbortSignal.any([
                AbortSignal.timeout(CALL_TIMEOUT_MS),
                ...(options.signal ? [options.signal] : []),
            ]),
        });
        const challenge = response.headers.get("www-authenticate") ?? "";
        if (response.status === 401 || (response.status === 403 && challenge.includes("insufficient_scope"))) {
            await response.body?.cancel();
            throw new ShopUnauthorized(
                challenge.includes("invalid_token") ? "Shop no longer accepts the sign-in" : "Shop needs a sign-in",
            );
        }
        if (response.status === 413) {
            await response.body?.cancel();
            throw new ShopError("That was too big for Shop. A photo has to be under about 3 MB.");
        }
        let answer: RpcResponse;
        try {
            answer = parseAnswer(await response.text(), response.headers.get("content-type") ?? "");
        } catch {
            throw new ShopError(`Shop answered HTTP ${response.status}`);
        }
        if (answer.error) throw new ShopError(`Shop refused the request: ${answer.error.message}`);
        const result = answer.result;
        if (!response.ok || !result) throw new ShopError(`Shop answered HTTP ${response.status}`);
        if (result.structuredContent) return result.structuredContent;
        const text = textOf(result.content);
        if (!result.isError) {
            try {
                return JSON.parse(text) as ShopDocument;
            } catch {
                throw new ShopError("Shop's answer had no document");
            }
        }
        const error = result._meta?.["com.shopify/error"] as
            | { code?: string; retry_after?: number; continue_url?: string }
            | undefined;
        if (error?.code === "sign_in_required") throw new ShopUnauthorized(text || "Shop needs a sign-in");
        throw new ShopError(text || "Shop could not do that", error?.code, error?.retry_after, error?.continue_url);
    }
}
