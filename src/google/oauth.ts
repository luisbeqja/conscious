import type { Connector, Credentials } from "../plugins/connectors.js";

export interface GoogleClient {
    clientId: string;
    clientSecret: string;
}

/** Calendar events and the calendar list; Gmail read and drafts. Nothing that deletes. */
export const GOOGLE_SCOPES = [
    "openid",
    "email",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
];

/** Signed in by redirect, so the Vault keeps a refresh token, never a pasted secret. */
export const GOOGLE_CONNECTOR: Connector = {
    id: "google",
    name: "Google (Calendar and Gmail)",
    hosts: ["oauth2.googleapis.com", "www.googleapis.com", "gmail.googleapis.com"],
    howTo: {
        url: "https://myaccount.google.com/connections",
        steps: [
            "Press Sign in with Google and pick your account.",
            "Allow Calendar and Gmail. Conscious can read mail and write drafts, never send or delete.",
            "You can remove access any time at myaccount.google.com/connections.",
        ],
    },
    verifyUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
    signIn: "google",
};

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Raised when Google no longer accepts the saved sign-in: revoked, expired, or a password change. */
export class GoogleSignInExpired extends Error {}

/**
 * The install's own OAuth client. Each install registers it once in Google Cloud, since
 * Conscious is self-hosted and has no central client to share.
 */
export class GoogleOAuth {
    private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

    constructor(
        private readonly client: GoogleClient,
        readonly redirectUri: string,
        private readonly credentials: Credentials,
        private readonly doFetch: typeof fetch = fetch,
    ) {}

    authUrl(state: string): string {
        const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        url.search = new URLSearchParams({
            client_id: this.client.clientId,
            redirect_uri: this.redirectUri,
            response_type: "code",
            scope: GOOGLE_SCOPES.join(" "),
            access_type: "offline",
            // Without it, Google returns no refresh token when the user signed in before.
            prompt: "consent",
            include_granted_scopes: "true",
            state,
        }).toString();
        return url.toString();
    }

    /** Swaps the code from the redirect for a refresh token, and checks the user granted every scope. */
    async exchange(code: string): Promise<string> {
        const body = await this.token({ grant_type: "authorization_code", code, redirect_uri: this.redirectUri });
        if (!body.refresh_token) throw new Error("Google sent no refresh token");
        const granted = new Set((body.scope ?? "").split(" "));
        const missing = GOOGLE_SCOPES.filter((scope) => scope.startsWith("https://") && !granted.has(scope));
        if (missing.length)
            throw new Error("Tick every box on Google's page, so Conscious can see your calendar and mail");
        return body.refresh_token;
    }

    /** A fresh access token for the user, kept until a minute before it expires. */
    async accessToken(userId: string): Promise<string> {
        const cached = this.tokens.get(userId);
        if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
        const saved = await this.credentials.credential(userId, GOOGLE_CONNECTOR.id);
        if (!saved) throw new GoogleSignInExpired("Google is not connected");
        const body = await this.token({ grant_type: "refresh_token", refresh_token: saved.token });
        if (!body.access_token) throw new Error("Google sent no access token");
        this.tokens.set(userId, { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 });
        return body.access_token;
    }

    forget(userId: string): void {
        this.tokens.delete(userId);
    }

    private async token(params: Record<string, string>) {
        const response = await this.doFetch(TOKEN_URL, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: new URLSearchParams({
                ...params,
                client_id: this.client.clientId,
                client_secret: this.client.clientSecret,
            }).toString(),
            signal: AbortSignal.timeout(15_000),
        });
        const body = (await response.json().catch(() => ({}))) as {
            access_token?: string;
            refresh_token?: string;
            expires_in?: number;
            scope?: string;
            error?: string;
        };
        if (body.error === "invalid_grant") throw new GoogleSignInExpired("Google no longer accepts the sign-in");
        if (!response.ok) throw new Error(`Google sign-in failed: ${body.error ?? response.status}`);
        return body;
    }
}
