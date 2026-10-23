import type { Connector, Credential } from "../plugins/connectors.js";
import type { Vault } from "../vault/vault.js";

export interface SpotifyClient {
    clientId: string;
    clientSecret: string;
}

/** What is playing, playback control, history and the user's own playlists. Nothing that follows or deletes. */
export const SPOTIFY_SCOPES = [
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing",
    "user-read-recently-played",
    "user-top-read",
    "playlist-read-private",
    "playlist-modify-private",
];

export const SPOTIFY_CONNECTOR: Connector = {
    id: "spotify",
    name: "Spotify",
    hosts: ["accounts.spotify.com", "api.spotify.com"],
    howTo: {
        url: "https://www.spotify.com/account/apps/",
        steps: [
            "Press Sign in with Spotify and log in.",
            "Allow access. Conscious can see and control what plays, and make private playlists.",
            "You can remove access any time at spotify.com/account/apps.",
        ],
    },
    verifyUrl: "https://api.spotify.com/v1/me",
    signIn: "Spotify",
};

const TOKEN_URL = "https://accounts.spotify.com/api/token";

export class SpotifySignInExpired extends Error {}

/**
 * Spotify only accepts loopback redirects as an IP address, never as "localhost", so a
 * localhost public URL is sent as 127.0.0.1. Anything else must be https.
 */
export const spotifyRedirect = (redirectUri: string): string => {
    const url = new URL(redirectUri);
    if (url.hostname === "localhost") url.hostname = "127.0.0.1";
    return url.href;
};

/** The install's own Spotify app, like Google's: each install registers it once. */
export class SpotifyOAuth {
    readonly redirectUri: string;
    private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

    constructor(
        private readonly client: SpotifyClient,
        redirectUri: string,
        private readonly vault: Pick<Vault, "credential" | "set">,
        private readonly doFetch: typeof fetch = fetch,
    ) {
        this.redirectUri = spotifyRedirect(redirectUri);
    }

    authUrl(state: string): string {
        const url = new URL("https://accounts.spotify.com/authorize");
        url.search = new URLSearchParams({
            client_id: this.client.clientId,
            response_type: "code",
            redirect_uri: this.redirectUri,
            scope: SPOTIFY_SCOPES.join(" "),
            state,
        }).toString();
        return url.toString();
    }

    async exchange(code: string): Promise<string> {
        const body = await this.token({ grant_type: "authorization_code", code, redirect_uri: this.redirectUri });
        if (!body.refresh_token) throw new Error("Spotify sent no refresh token");
        return body.refresh_token;
    }

    async accessToken(userId: string): Promise<string> {
        const cached = this.tokens.get(userId);
        if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
        const saved: Credential | undefined = await this.vault.credential(userId, SPOTIFY_CONNECTOR.id);
        if (!saved) throw new SpotifySignInExpired("Spotify is not connected");
        const body = await this.token({ grant_type: "refresh_token", refresh_token: saved.token });
        if (!body.access_token) throw new Error("Spotify sent no access token");
        // Spotify may rotate the refresh token; the old one then stops working.
        if (body.refresh_token && body.refresh_token !== saved.token) {
            this.vault.set(userId, SPOTIFY_CONNECTOR, body.refresh_token);
        }
        this.tokens.set(userId, { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 });
        return body.access_token;
    }

    forget(userId: string): void {
        this.tokens.delete(userId);
    }

    private async token(params: Record<string, string>) {
        const response = await this.doFetch(TOKEN_URL, {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                authorization: `Basic ${Buffer.from(`${this.client.clientId}:${this.client.clientSecret}`).toString("base64")}`,
            },
            body: new URLSearchParams(params).toString(),
            signal: AbortSignal.timeout(15_000),
        });
        const body = (await response.json().catch(() => ({}))) as {
            access_token?: string;
            refresh_token?: string;
            expires_in?: number;
            error?: string;
        };
        if (body.error === "invalid_grant") throw new SpotifySignInExpired("Spotify no longer accepts the sign-in");
        if (!response.ok) throw new Error(`Spotify sign-in failed: ${body.error ?? response.status}`);
        return body;
    }
}
