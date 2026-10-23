import { Type } from "typebox";
import type { Credentials } from "../../plugins/connectors.js";
import { promptFile } from "../../prompts/prompt-file.js";
import { SPOTIFY_CONNECTOR, type SpotifyOAuth, SpotifySignInExpired } from "../../spotify/oauth.js";
import { type Capability, defineTool, type RegisteredTool, type ToolContext, type ToolOutput } from "../types.js";

const API = "https://api.spotify.com/v1";

/** Spotify's own reason for a refused player call, put in words the agent can pass on. */
const REASONS: Record<string, string> = {
    PREMIUM_REQUIRED: "Controlling playback needs Spotify Premium. Searching, history and playlists still work.",
    NO_ACTIVE_DEVICE:
        "Nothing is playing anywhere. Ask the user to open Spotify on a phone, computer or speaker first.",
};

class SpotifyRefused extends Error {
    constructor(readonly guidance: string) {
        super(guidance);
    }
}

interface Artist {
    name: string;
}
interface Track {
    uri: string;
    name: string;
    artists?: Artist[];
    album?: { name: string };
    duration_ms?: number;
    external_urls?: { spotify?: string };
}

const track = (item: Track | null | undefined) =>
    item && {
        uri: item.uri,
        title: item.name,
        artists: item.artists?.map((artist) => artist.name).join(", "),
        album: item.album?.name,
        link: item.external_urls?.spotify,
    };

/** Calls Spotify as the user. A rejected token is refreshed once. */
const request = async <T>(
    oauth: SpotifyOAuth,
    doFetch: typeof fetch,
    context: ToolContext,
    path: string,
    init: { method?: string; query?: Record<string, string | number | undefined>; body?: unknown } = {},
): Promise<T | undefined> => {
    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
    }
    for (let attempt = 0; attempt < 2; attempt++) {
        const response = await doFetch(url, {
            method: init.method ?? "GET",
            headers: {
                authorization: `Bearer ${await oauth.accessToken(context.userId)}`,
                ...(init.body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
            signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(context.signal ? [context.signal] : [])]),
        });
        if (response.status === 401 && attempt === 0) {
            await response.body?.cancel();
            oauth.forget(context.userId);
            continue;
        }
        const text = await response.text();
        if (response.status === 401) throw new SpotifySignInExpired("Spotify no longer accepts the sign-in");
        const body = text ? JSON.parse(text) : undefined;
        if (!response.ok) {
            const error = (body as { error?: { message?: string; reason?: string } } | undefined)?.error;
            const reason = error?.reason && REASONS[error.reason];
            if (reason) throw new SpotifyRefused(reason);
            throw new Error(`Spotify: ${error?.message ?? `HTTP ${response.status}`}`);
        }
        return body as T | undefined;
    }
    throw new SpotifySignInExpired("Spotify no longer accepts the sign-in");
};

const guarded = (tool: RegisteredTool): RegisteredTool => ({
    ...tool,
    execute: async (params, context): Promise<ToolOutput> => {
        try {
            return await tool.execute(params as never, context);
        } catch (error) {
            if (error instanceof SpotifyRefused) return { data: { error: error.message }, guidance: error.guidance };
            if (!(error instanceof SpotifySignInExpired)) throw error;
            return {
                data: { error: "Spotify no longer accepts the sign-in." },
                guidance:
                    'Call vault_request_connection with connector "spotify" and send the user the link to sign in again.',
            };
        }
    },
});

const URI = /^spotify:(track|album|playlist|artist|episode|show):[A-Za-z0-9]+$/;

export const createSpotifyCapability = (
    oauth: SpotifyOAuth,
    credentials: Credentials,
    doFetch: typeof fetch = fetch,
): Capability => {
    const call = <T>(context: ToolContext, path: string, init?: Parameters<typeof request>[4]) =>
        request<T>(oauth, doFetch, context, path, init);

    const nowPlaying = defineTool({
        name: "spotify_now_playing",
        label: "What's playing",
        description: "What the user is listening to right now on Spotify, on which device, and the devices they have.",
        effect: "read",
        parameters: Type.Object({}),
        execute: async (_params, context) => {
            const [player, devices] = await Promise.all([
                call<{ is_playing: boolean; progress_ms?: number; item?: Track; device?: { name: string } }>(
                    context,
                    "/me/player",
                ),
                call<{ devices: { id: string; name: string; type: string; is_active: boolean }[] }>(
                    context,
                    "/me/player/devices",
                ),
            ]);
            return {
                data: {
                    playing: player?.is_playing ?? false,
                    track: track(player?.item),
                    device: player?.device?.name,
                    devices: (devices?.devices ?? []).map((device) => ({
                        id: device.id,
                        name: device.name,
                        type: device.type,
                        active: device.is_active,
                    })),
                },
            };
        },
    });

    const search = defineTool({
        name: "spotify_search",
        label: "Search Spotify",
        description: "Find songs, albums, artists or playlists. Returns Spotify URIs to play or queue.",
        effect: "read",
        parameters: Type.Object({
            query: Type.String({ minLength: 1 }),
            type: Type.Optional(
                Type.Union([
                    Type.Literal("track"),
                    Type.Literal("album"),
                    Type.Literal("artist"),
                    Type.Literal("playlist"),
                ]),
            ),
        }),
        execute: async (params, context) => {
            const type = params.type ?? "track";
            // Spotify caps a search at 10 results for apps like this one.
            const body = await call<Record<string, { items: (Track & { owner?: { display_name?: string } })[] }>>(
                context,
                "/search",
                { query: { q: params.query, type, limit: 8 } },
            );
            const items = (body?.[`${type}s`]?.items ?? []).filter(Boolean);
            return {
                data: items.map((item) =>
                    type === "track"
                        ? track(item)
                        : {
                              uri: item.uri,
                              name: item.name,
                              by: item.artists?.map((artist) => artist.name).join(", ") ?? item.owner?.display_name,
                              link: item.external_urls?.spotify,
                          },
                ),
            };
        },
    });

    const control = defineTool({
        name: "spotify_control_playback",
        label: "Control Spotify",
        description:
            "Play, pause, skip or go back on the user's Spotify. `play` with a URI starts that song, album, artist or playlist; without one it resumes. Needs Spotify Premium.",
        effect: "draft",
        parameters: Type.Object({
            action: Type.Union([
                Type.Literal("play"),
                Type.Literal("pause"),
                Type.Literal("next"),
                Type.Literal("previous"),
            ]),
            uri: Type.Optional(Type.String({ description: "spotify:track:…, spotify:album:…, spotify:playlist:…" })),
            device: Type.Optional(Type.String({ description: "Device id from spotify_now_playing" })),
        }),
        execute: async (params, context) => {
            if (params.uri && !URI.test(params.uri)) throw new Error("uri must be a Spotify URI from spotify_search");
            const query = { device_id: params.device };
            if (params.action === "play") {
                const body = params.uri
                    ? params.uri.startsWith("spotify:track:")
                        ? { uris: [params.uri] }
                        : { context_uri: params.uri }
                    : undefined;
                await call(context, "/me/player/play", { method: "PUT", query, body });
            } else if (params.action === "pause") {
                await call(context, "/me/player/pause", { method: "PUT", query });
            } else {
                await call(context, `/me/player/${params.action}`, { method: "POST", query });
            }
            return { data: { done: params.action } };
        },
    });

    const queue = defineTool({
        name: "spotify_add_to_queue",
        label: "Queue a song",
        description: "Add a song to the end of the user's Spotify queue. Needs Spotify Premium.",
        effect: "draft",
        parameters: Type.Object({ uri: Type.String({ description: "spotify:track:… from spotify_search" }) }),
        execute: async (params, context) => {
            if (!URI.test(params.uri)) throw new Error("uri must be a Spotify URI from spotify_search");
            await call(context, "/me/player/queue", { method: "POST", query: { uri: params.uri } });
            return { data: { queued: params.uri } };
        },
    });

    const history = defineTool({
        name: "spotify_list_history",
        label: "Listening history",
        description:
            "What the user listened to: `recent` (last 20 songs), or their top `tracks` or `artists` over the last 4 weeks, 6 months or year.",
        effect: "read",
        parameters: Type.Object({
            kind: Type.Union([Type.Literal("recent"), Type.Literal("tracks"), Type.Literal("artists")]),
            range: Type.Optional(
                Type.Union([Type.Literal("short_term"), Type.Literal("medium_term"), Type.Literal("long_term")], {
                    description: "4 weeks, 6 months (default) or a year",
                }),
            ),
        }),
        execute: async (params, context) => {
            if (params.kind === "recent") {
                const body = await call<{ items: { track: Track; played_at: string }[] }>(
                    context,
                    "/me/player/recently-played",
                    { query: { limit: 20 } },
                );
                return {
                    data: (body?.items ?? []).map((item) => ({ ...track(item.track), playedAt: item.played_at })),
                };
            }
            const body = await call<{ items: (Track & { genres?: string[] })[] }>(context, `/me/top/${params.kind}`, {
                query: { limit: 15, time_range: params.range ?? "medium_term" },
            });
            return {
                data: (body?.items ?? []).map((item) =>
                    params.kind === "tracks" ? track(item) : { name: item.name, genres: item.genres?.slice(0, 3) },
                ),
            };
        },
    });

    const playlists = defineTool({
        name: "spotify_list_playlists",
        label: "List playlists",
        description: "The user's own and followed Spotify playlists, with URIs to play.",
        effect: "read",
        parameters: Type.Object({}),
        execute: async (_params, context) => {
            const body = await call<{
                items: { id: string; uri: string; name: string; owner?: { display_name?: string } }[];
            }>(context, "/me/playlists", { query: { limit: 50 } });
            return {
                data: (body?.items ?? []).map((item) => ({
                    id: item.id,
                    uri: item.uri,
                    name: item.name,
                    owner: item.owner?.display_name,
                })),
            };
        },
    });

    const createPlaylist = defineTool({
        name: "spotify_create_playlist",
        label: "Make a playlist",
        description: "Create a private playlist in the user's Spotify with the given songs.",
        effect: "draft",
        parameters: Type.Object({
            name: Type.String({ minLength: 1, maxLength: 100 }),
            description: Type.Optional(Type.String({ maxLength: 300 })),
            tracks: Type.Array(Type.String({ description: "spotify:track:… URIs" }), { minItems: 1, maxItems: 100 }),
        }),
        execute: async (params, context) => {
            const bad = params.tracks.filter((uri) => !uri.startsWith("spotify:track:") || !URI.test(uri));
            if (bad.length) throw new Error(`Not track URIs: ${bad.join(", ")}`);
            const created = await call<{ id: string; uri: string; external_urls?: { spotify?: string } }>(
                context,
                "/me/playlists",
                { method: "POST", body: { name: params.name, description: params.description, public: false } },
            );
            if (!created) throw new Error("Spotify did not create the playlist");
            await call(context, `/playlists/${encodeURIComponent(created.id)}/items`, {
                method: "POST",
                body: { uris: params.tracks },
            });
            return { data: { uri: created.uri, link: created.external_urls?.spotify, songs: params.tracks.length } };
        },
    });

    return {
        id: "spotify",
        summary:
            "The user's Spotify: what is playing, play/pause/skip and queue songs (Premium), search, listening history, and their playlists.",
        skill: promptFile(import.meta.url, "SKILL.md"),
        tools: [nowPlaying, search, control, queue, history, playlists, createPlaylist].map(guarded),
        available: async (userId) => Boolean(await credentials.credential(userId, SPOTIFY_CONNECTOR.id)),
    };
};
