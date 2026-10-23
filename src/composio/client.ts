import { createHash } from "node:crypto";

export interface ComposioConfig {
    apiKey: string;
    baseUrl?: string;
    /**
     * The install's own auth configs by app (`googlecalendar` → `ac_…`), made in the Composio
     * dashboard with the owner's OAuth apps, so the sign-in shows Conscious instead of Composio.
     */
    authConfigs?: Record<string, string>;
    /** The apps it may reach, by Composio id; unset means the everyday-life list. */
    apps?: readonly string[] | "all";
}

export interface ComposioApp {
    app: string;
    name: string;
    description?: string;
    connected: boolean;
    /** The app needs no sign-in at all. */
    noSignIn: boolean;
}

export interface ComposioToolMatch {
    task: string;
    tools: { tool: string; app: string; description?: string; inputs?: unknown }[];
    apps: { app: string; connected: boolean; status: string }[];
    guidance?: string;
    pitfalls?: string[];
}

export interface ComposioResult {
    ok: boolean;
    data: unknown;
    error?: string;
}

const DEFAULT_BASE = "https://backend.composio.dev";

/** Composio sees an opaque id, never the user's phone number or name. */
export const composioUserId = (userId: string): string =>
    `conscious-${createHash("sha256").update(userId).digest("hex").slice(0, 32)}`;

/**
 * Composio's tool router, over plain HTTP: one session per user, in which Composio holds that
 * user's app sign-ins and runs app tools as them. The install's API key never reaches the model.
 */
export class ComposioClient {
    private readonly base: string;
    private readonly sessions = new Map<string, Promise<string>>();
    private readonly tags = new Map<string, Promise<string[]>>();

    constructor(
        private readonly config: ComposioConfig,
        private readonly doFetch: typeof fetch = fetch,
    ) {
        this.base = (config.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    }

    async apps(userId: string, filter: { search?: string; connectedOnly?: boolean } = {}): Promise<ComposioApp[]> {
        const query = new URLSearchParams({ limit: "20" });
        if (filter.search) query.set("search", filter.search);
        if (filter.connectedOnly) query.set("is_connected", "true");
        const body = await this.inSession<{
            items: {
                slug: string;
                name: string;
                is_no_auth: boolean;
                meta?: { description?: string };
                connected_account: { status: string } | null;
            }[];
        }>(userId, "GET", `toolkits?${query}`);
        return body.items.map((item) => ({
            app: item.slug,
            name: item.name,
            description: item.meta?.description,
            connected: item.connected_account?.status === "ACTIVE",
            noSignIn: item.is_no_auth,
        }));
    }

    /** A Composio page where the user signs in to the app. */
    async connectLink(userId: string, app: string, callbackUrl?: string): Promise<string> {
        const body = await this.inSession<{ redirect_url: string }>(userId, "POST", "link", {
            toolkit: app,
            ...(callbackUrl ? { callback_url: callbackUrl } : {}),
        });
        return body.redirect_url;
    }

    async findTools(userId: string, task: string): Promise<ComposioToolMatch> {
        const body = await this.inSession<{
            error: string | null;
            results: {
                use_case: string;
                primary_tool_slugs: string[];
                related_tool_slugs: string[];
                execution_guidance?: string;
                known_pitfalls?: string[];
                error?: string | null;
            }[];
            tool_schemas: Record<
                string,
                { toolkit: string; tool_slug: string; description?: string; input_schema?: unknown }
            >;
            toolkit_connection_statuses: { toolkit: string; has_active_connection: boolean; status_message: string }[];
        }>(userId, "POST", "search", { queries: [{ use_case: task }] });
        const result = body.results[0];
        if (!result) throw new Error(`Composio found no tools: ${body.error ?? "no result"}`);
        const slugs = [...result.primary_tool_slugs, ...result.related_tool_slugs].slice(0, 6);
        return {
            task: result.use_case,
            tools: slugs.map((slug) => {
                const schema = body.tool_schemas[slug];
                return {
                    tool: slug,
                    app: schema?.toolkit ?? "",
                    description: schema?.description,
                    inputs: schema?.input_schema,
                };
            }),
            apps: body.toolkit_connection_statuses.map((status) => ({
                app: status.toolkit,
                connected: status.has_active_connection,
                status: status.status_message,
            })),
            guidance: result.execution_guidance,
            pitfalls: result.known_pitfalls,
        };
    }

    /** What the tool says about itself: readOnlyHint, destructiveHint and so on. Cached per run. */
    toolTags(tool: string): Promise<string[]> {
        let tags = this.tags.get(tool);
        if (!tags) {
            tags = this.call<{ tags?: string[] }>("GET", `/api/v3.1/tools/${encodeURIComponent(tool)}`).then(
                (body) => body.tags ?? [],
            );
            tags.catch(() => this.tags.delete(tool));
            this.tags.set(tool, tags);
        }
        return tags;
    }

    async run(userId: string, tool: string, args: Record<string, unknown>): Promise<ComposioResult> {
        const body = await this.inSession<{ result_type: string; data?: unknown; error?: string | null }>(
            userId,
            "POST",
            "execute",
            { tool_slug: tool, arguments: args },
        );
        return {
            ok: body.result_type === "completed",
            data: body.data,
            error: body.error ?? (body.result_type === "input_required" ? "The tool needs more input" : undefined),
        };
    }

    /** A request inside the user's session. A session Composio has forgotten is made again once. */
    private async inSession<T>(userId: string, method: string, path: string, body?: unknown): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            const session = await this.session(userId);
            try {
                return await this.call<T>(method, `/api/v3.1/tool_router/session/${session}/${path}`, body);
            } catch (error) {
                if (!(error instanceof ComposioHttpError && error.status === 404) || attempt > 0) throw error;
                this.sessions.delete(userId);
            }
        }
    }

    private session(userId: string): Promise<string> {
        let session = this.sessions.get(userId);
        if (!session) {
            session = this.call<{ session_id: string }>("POST", "/api/v3.1/tool_router/session", {
                user_id: composioUserId(userId),
                // Conscious offers its own connect tool, so Composio's meta tools stay out of the session.
                manage_connections: { enable: false },
                ...(this.config.authConfigs ? { auth_configs: this.config.authConfigs } : {}),
            }).then((body) => body.session_id);
            session.catch(() => this.sessions.delete(userId));
            this.sessions.set(userId, session);
        }
        return session;
    }

    private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
        const response = await this.doFetch(`${this.base}${path}`, {
            method,
            headers: {
                "x-api-key": this.config.apiKey,
                ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(60_000),
        });
        const text = await response.text();
        if (!response.ok) {
            let message = text.slice(0, 300);
            try {
                const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
                message =
                    (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ??
                    parsed.message ??
                    message;
            } catch {}
            throw new ComposioHttpError(response.status, `Composio: ${message || `HTTP ${response.status}`}`);
        }
        return (text ? JSON.parse(text) : {}) as T;
    }
}

export class ComposioHttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}
