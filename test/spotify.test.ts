import { describe, expect, it } from "vitest";
import { createSpotifyCapability } from "../src/capabilities/spotify/capability.js";
import type { ToolContext } from "../src/capabilities/types.js";
import { resolveConnector } from "../src/plugins/connectors.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { SPOTIFY_CONNECTOR, SpotifyOAuth, spotifyRedirect } from "../src/spotify/oauth.js";
import { Vault } from "../src/vault/vault.js";

const context: ToolContext = { userId: "me", timezone: "Europe/Rome", scheduler: new Scheduler(async () => {}) };
const client = { clientId: "spotify-id", clientSecret: "spotify-secret" };

type Route = (url: URL, init?: RequestInit) => Response | undefined;
const fakeSpotify = (...routes: Route[]) => {
    const calls: { url: URL; init?: RequestInit }[] = [];
    const doFetch = (async (input: string | URL, init?: RequestInit) => {
        const url = new URL(input);
        calls.push({ url, init });
        if (url.href === "https://accounts.spotify.com/api/token") {
            return Response.json({ access_token: "BQ-fresh", refresh_token: "rotated", expires_in: 3600 });
        }
        for (const route of routes) {
            const response = route(url, init);
            if (response) return response;
        }
        return Response.json({ error: { status: 404, message: "not found" } }, { status: 404 });
    }) as typeof fetch;
    return { calls, doFetch };
};

const setup = (...routes: Route[]) => {
    const vault = new Vault();
    vault.set("me", SPOTIFY_CONNECTOR, "refresh-1");
    const fake = fakeSpotify(...routes);
    const oauth = new SpotifyOAuth(client, "http://localhost:8787/vault/oauth/spotify", vault, fake.doFetch);
    const capability = createSpotifyCapability(oauth, vault, fake.doFetch);
    const tool = (name: string) => {
        const found = capability.tools.find((candidate) => candidate.name === name);
        if (!found) throw new Error(name);
        return found;
    };
    return { ...fake, vault, oauth, capability, tool };
};

describe("Spotify", () => {
    it("sends a loopback redirect as 127.0.0.1, since Spotify refuses localhost", () => {
        expect(spotifyRedirect("http://localhost:8787/vault/oauth/spotify")).toBe(
            "http://127.0.0.1:8787/vault/oauth/spotify",
        );
        const { oauth } = setup();
        const url = new URL(oauth.authUrl("state-code"));
        expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8787/vault/oauth/spotify");
        expect(url.searchParams.get("scope")).toContain("user-modify-playback-state");
        expect(url.searchParams.get("scope")).not.toMatch(/user-follow-modify|ugc-image|user-library-modify/);
    });

    it("keeps a refresh token Spotify rotated, and keeps Spotify away from plugins", async () => {
        const { vault, tool } = setup((url) =>
            url.pathname === "/v1/me/player/recently-played" ? Response.json({ items: [] }) : undefined,
        );
        await tool("spotify_list_history").execute({ kind: "recent" }, context);
        expect((await vault.credential("me", "spotify"))?.token).toBe("rotated");
        expect(resolveConnector({ connector: "spotify" }).problems[0]).toMatch(/cannot be used by a plugin/);
    });

    it("says nothing plays when the player is empty", async () => {
        const { tool } = setup(
            (url) => (url.pathname === "/v1/me/player" ? new Response(null, { status: 204 }) : undefined),
            (url) => (url.pathname === "/v1/me/player/devices" ? Response.json({ devices: [] }) : undefined),
        );
        const output = await tool("spotify_now_playing").execute({}, context);
        expect(output.data).toEqual({ playing: false, track: undefined, device: undefined, devices: [] });
    });

    it("plays a track by URI and an album as its context", async () => {
        const bodies: unknown[] = [];
        const { tool } = setup((url, init) => {
            if (url.pathname !== "/v1/me/player/play") return undefined;
            bodies.push(JSON.parse(init?.body as string));
            return new Response(null, { status: 204 });
        });
        const control = tool("spotify_control_playback");
        await control.execute({ action: "play", uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC" }, context);
        await control.execute({ action: "play", uri: "spotify:album:1DFixLWuPkv3KT3TnV35m3" }, context);
        expect(bodies).toEqual([
            { uris: ["spotify:track:4uLU6hMCjMI75M1A2tKUQC"] },
            { context_uri: "spotify:album:1DFixLWuPkv3KT3TnV35m3" },
        ]);
        await expect(control.execute({ action: "play", uri: "https://evil.example" }, context)).rejects.toThrow(
            /Spotify URI/,
        );
    });

    it("turns Premium and no-device refusals into words for the user", async () => {
        const { tool } = setup((url) =>
            url.pathname === "/v1/me/player/queue"
                ? Response.json({ error: { status: 403, reason: "PREMIUM_REQUIRED" } }, { status: 403 })
                : undefined,
        );
        const output = await tool("spotify_add_to_queue").execute({ uri: "spotify:track:abc" }, context);
        expect(output.guidance).toMatch(/Premium/);
    });

    it("makes a private playlist and adds the songs to it", async () => {
        const sent: { path: string; body: unknown }[] = [];
        const { tool } = setup((url, init) => {
            if (init?.method !== "POST") return undefined;
            sent.push({ path: url.pathname, body: JSON.parse(init.body as string) });
            if (url.pathname === "/v1/me/playlists") {
                return Response.json({ id: "p1", uri: "spotify:playlist:p1", external_urls: { spotify: "https://x" } });
            }
            return Response.json({ snapshot_id: "s" });
        });
        const output = await tool("spotify_create_playlist").execute(
            { name: "Sunday cooking", tracks: ["spotify:track:a1", "spotify:track:b2"] },
            context,
        );
        expect(output.data).toEqual({ uri: "spotify:playlist:p1", link: "https://x", songs: 2 });
        expect(sent).toEqual([
            { path: "/v1/me/playlists", body: { name: "Sunday cooking", public: false } },
            { path: "/v1/playlists/p1/items", body: { uris: ["spotify:track:a1", "spotify:track:b2"] } },
        ]);
    });
});
