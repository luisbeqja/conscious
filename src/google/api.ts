import { type GoogleOAuth, GoogleSignInExpired } from "./oauth.js";

/** Calls Google as the user. A rejected token is refreshed once before giving up. */
export class GoogleApi {
    constructor(
        private readonly oauth: GoogleOAuth,
        private readonly doFetch: typeof fetch = fetch,
    ) {}

    async request<T>(
        userId: string,
        url: string,
        init: {
            method?: string;
            query?: Record<string, string | number | boolean | undefined>;
            body?: unknown;
            /** The body as text, for file downloads and exports. */
            text?: boolean;
        } = {},
        signal?: AbortSignal,
    ): Promise<T> {
        const target = new URL(url);
        for (const [key, value] of Object.entries(init.query ?? {})) {
            if (value !== undefined) target.searchParams.set(key, String(value));
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            const response = await this.doFetch(target, {
                method: init.method ?? "GET",
                headers: {
                    authorization: `Bearer ${await this.oauth.accessToken(userId)}`,
                    accept: "application/json",
                    ...(init.body === undefined ? {} : { "content-type": "application/json" }),
                },
                body: init.body === undefined ? undefined : JSON.stringify(init.body),
                signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
            });
            if (response.status === 401 && attempt === 0) {
                await response.body?.cancel();
                this.oauth.forget(userId);
                continue;
            }
            const text = await response.text();
            if (response.status === 401) throw new GoogleSignInExpired("Google no longer accepts the sign-in");
            if (response.ok && init.text) return text as T;
            const body = text ? JSON.parse(text) : {};
            if (!response.ok) {
                const error = (body as { error?: { message?: string; details?: { reason?: string }[] } }).error;
                // A sign-in from before Conscious asked for this permission: a new one grants it.
                if (error?.details?.some((detail) => detail.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
                    throw new GoogleSignInExpired("The Google sign-in is missing a permission added since");
                }
                throw new Error(`Google: ${error?.message ?? `HTTP ${response.status}`}`);
            }
            return body as T;
        }
        throw new GoogleSignInExpired("Google no longer accepts the sign-in");
    }
}
