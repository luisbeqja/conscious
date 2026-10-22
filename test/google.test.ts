import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createGoogleCapability } from "../src/capabilities/google/capability.js";
import type { ToolContext } from "../src/capabilities/types.js";
import { GoogleApi } from "../src/google/api.js";
import { messageText, rawMessage } from "../src/google/mail.js";
import { GOOGLE_CONNECTOR, GOOGLE_SCOPES, GoogleOAuth } from "../src/google/oauth.js";
import { resolveConnector } from "../src/plugins/connectors.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { createVaultServer } from "../src/vault/server.js";
import { Vault } from "../src/vault/vault.js";

const context: ToolContext = { userId: "me", timezone: "Europe/Rome", scheduler: new Scheduler(async () => {}) };
const client = { clientId: "id.apps.googleusercontent.com", clientSecret: "s3cret" };
const allScopes = GOOGLE_SCOPES.join(" ");

type Route = (url: URL, init?: RequestInit) => Response | undefined;
const fakeGoogle = (...routes: Route[]) => {
    const calls: { url: URL; init?: RequestInit }[] = [];
    const doFetch = (async (input: URL | string, init?: RequestInit) => {
        const url = new URL(input);
        calls.push({ url, init });
        if (url.href === "https://oauth2.googleapis.com/token") {
            const body = new URLSearchParams(init?.body as string);
            if (body.get("grant_type") === "refresh_token" && body.get("refresh_token") === "revoked") {
                return Response.json({ error: "invalid_grant" }, { status: 400 });
            }
            return Response.json({
                access_token: "ya29.fresh",
                refresh_token: "1//refresh",
                expires_in: 3600,
                scope: allScopes,
            });
        }
        for (const route of routes) {
            const response = route(url, init);
            if (response) return response;
        }
        return Response.json({ error: { message: "not found" } }, { status: 404 });
    }) as typeof fetch;
    return { calls, doFetch };
};

const connected = (refreshToken = "1//refresh") => {
    const vault = new Vault();
    vault.set("me", GOOGLE_CONNECTOR, refreshToken);
    return vault;
};

const toolOf = (capability: ReturnType<typeof createGoogleCapability>, name: string) => {
    const tool = capability.tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(name);
    return tool;
};

describe("Google sign-in on the Vault page", () => {
    let server: Server | undefined;
    afterEach(() => server?.close());

    it("sends the user to Google and keeps the refresh token it gets back", async () => {
        const vault = new Vault();
        const { doFetch } = fakeGoogle();
        const told: string[] = [];
        const oauth = new GoogleOAuth(client, "https://me.example/vault/oauth/google", vault, doFetch);
        server = createVaultServer({
            vault,
            verify: async () => false,
            onConnected: async (userId, connector) => {
                told.push(`${userId}:${connector.id}`);
            },
            signIn: {
                callbackPath: "/vault/oauth/google",
                authUrl: (state) => oauth.authUrl(state),
                exchange: (code) => oauth.exchange(code),
            },
        }).listen(0);
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const { code } = vault.createLink("me", GOOGLE_CONNECTOR);

        expect(await (await fetch(`${base}/vault/${code}`)).text()).toContain("Sign in with Google");
        const start = await fetch(`${base}/vault/${code}/start`, { redirect: "manual" });
        const google = new URL(start.headers.get("location") ?? "");
        expect(google.host).toBe("accounts.google.com");
        expect(google.searchParams.get("state")).toBe(code);
        expect(google.searchParams.get("access_type")).toBe("offline");
        expect(google.searchParams.get("scope")).toContain("gmail.compose");
        expect(google.searchParams.get("scope")).not.toMatch(/mail\.google\.com\/|gmail\.send|gmail\.modify/);

        const back = await fetch(`${base}/vault/oauth/google?state=${code}&code=4/abc`);
        expect(back.status).toBe(200);
        expect((await vault.credential("me", "google"))?.token).toBe("1//refresh");
        expect(told).toEqual(["me:google"]);
        expect((await fetch(`${base}/vault/oauth/google?state=${code}&code=4/abc`)).status).toBe(410);
    });

    it("refuses a sign-in where boxes were left unticked", async () => {
        const doFetch = (async () =>
            Response.json({ access_token: "a", refresh_token: "r", scope: "openid email" })) as unknown as typeof fetch;
        const oauth = new GoogleOAuth(client, "https://me.example/cb", new Vault(), doFetch);
        await expect(oauth.exchange("4/abc")).rejects.toThrow(/Tick every box/);
    });

    it("keeps Google's sign-in away from plugins", () => {
        expect(resolveConnector({ connector: "google", name: "G", hosts: ["www.googleapis.com"] }).problems[0]).toMatch(
            /cannot be used by a plugin/,
        );
    });
});

describe("Google capability", () => {
    it("is offered only once Google is connected", async () => {
        const { doFetch } = fakeGoogle();
        const vault = new Vault();
        const capability = createGoogleCapability(
            new GoogleApi(new GoogleOAuth(client, "x", vault, doFetch), doFetch),
            vault,
        );
        expect(await capability.available?.("me")).toBe(false);
        vault.set("me", GOOGLE_CONNECTOR, "1//refresh");
        expect(await capability.available?.("me")).toBe(true);
    });

    it("lists events in the user's timezone, refreshing the token once", async () => {
        const vault = connected();
        const { calls, doFetch } = fakeGoogle((url) =>
            url.pathname.endsWith("/calendars/primary/events")
                ? Response.json({
                      items: [
                          {
                              id: "e1",
                              summary: "Dentist",
                              start: { dateTime: "2026-10-23T09:00:00+02:00" },
                              end: { dateTime: "2026-10-23T10:00:00+02:00" },
                          },
                          { id: "e2", status: "cancelled" },
                          {
                              id: "e3",
                              summary: "Nonna's birthday",
                              start: { date: "2026-10-25" },
                              end: { date: "2026-10-26" },
                          },
                      ],
                  })
                : undefined,
        );
        const capability = createGoogleCapability(
            new GoogleApi(new GoogleOAuth(client, "x", vault, doFetch), doFetch),
            vault,
        );
        const list = toolOf(capability, "google_list_events");
        const output = await list.execute({}, context);
        await list.execute({}, context);

        expect(
            (output.data as { title: string; allDay: boolean }[]).map((event) => [event.title, event.allDay]),
        ).toEqual([
            ["Dentist", false],
            ["Nonna's birthday", true],
        ]);
        const calendarCall = calls.find((call) => call.url.pathname.endsWith("/events"));
        expect(calendarCall?.url.searchParams.get("timeZone")).toBe("Europe/Rome");
        expect((calendarCall?.init?.headers as Record<string, string>).authorization).toBe("Bearer ya29.fresh");
        expect(calls.filter((call) => call.url.host === "oauth2.googleapis.com")).toHaveLength(1);
    });

    it("adds an all-day event that ends the next day, and invites nobody", async () => {
        const vault = connected();
        let sent: { body: unknown; sendUpdates: string | null } | undefined;
        const { doFetch } = fakeGoogle((url, init) => {
            if (init?.method !== "POST" || !url.pathname.endsWith("/events")) return undefined;
            sent = { body: JSON.parse(init.body as string), sendUpdates: url.searchParams.get("sendUpdates") };
            return Response.json({
                id: "new",
                summary: "Holiday",
                start: { date: "2026-12-24" },
                end: { date: "2026-12-25" },
            });
        });
        const capability = createGoogleCapability(
            new GoogleApi(new GoogleOAuth(client, "x", vault, doFetch), doFetch),
            vault,
        );
        await toolOf(capability, "google_create_event").execute(
            { title: "Holiday", start: "2026-12-24", allDay: true },
            context,
        );
        expect(sent).toEqual({
            body: { summary: "Holiday", start: { date: "2026-12-24" }, end: { date: "2026-12-25" } },
            sendUpdates: "none",
        });
    });

    it("asks for a new sign-in when Google revoked the old one", async () => {
        const vault = connected("revoked");
        const { doFetch } = fakeGoogle();
        const capability = createGoogleCapability(
            new GoogleApi(new GoogleOAuth(client, "x", vault, doFetch), doFetch),
            vault,
        );
        const output = await toolOf(capability, "google_search_mail").execute({ query: "is:unread" }, context);
        expect(output.guidance).toMatch(/vault_request_connection/);
    });

    it("writes drafts in the reply's thread and never sends", async () => {
        const vault = connected();
        let draft: { message: { raw: string; threadId?: string } } | undefined;
        const { calls, doFetch } = fakeGoogle(
            (url) =>
                url.pathname.endsWith("/messages/m1")
                    ? Response.json({
                          id: "m1",
                          threadId: "t1",
                          payload: { headers: [{ name: "Message-ID", value: "<abc@mail>" }] },
                      })
                    : undefined,
            (url, init) => {
                if (!url.pathname.endsWith("/drafts")) return undefined;
                draft = JSON.parse(init?.body as string);
                return Response.json({ id: "d1" });
            },
        );
        const capability = createGoogleCapability(
            new GoogleApi(new GoogleOAuth(client, "x", vault, doFetch), doFetch),
            vault,
        );
        await toolOf(capability, "google_draft_mail").execute(
            { to: "ada@example.com", subject: "Cena di giovedì", body: "Ciao!\nVa bene alle 20?", replyTo: "m1" },
            context,
        );
        expect(draft?.message.threadId).toBe("t1");
        const raw = Buffer.from(draft?.message.raw ?? "", "base64url").toString("utf8");
        expect(raw).toContain("In-Reply-To: <abc@mail>");
        expect(raw).toContain("Subject: =?UTF-8?B?");
        expect(raw).toContain("Ciao!\r\nVa bene alle 20?");
        expect(calls.some((call) => call.url.pathname.includes("/send"))).toBe(false);
    });
});

describe("Gmail messages", () => {
    it("prefers the plain-text part and falls back to the HTML one", () => {
        const b64 = (text: string) => Buffer.from(text).toString("base64url");
        const html = {
            id: "1",
            threadId: "1",
            payload: { mimeType: "text/html", body: { data: b64("<p>Hi <b>there</b></p>") } },
        };
        expect(messageText(html)).toBe("Hi there");
        const both = {
            id: "2",
            threadId: "2",
            payload: {
                mimeType: "multipart/alternative",
                parts: [{ mimeType: "text/plain", body: { data: b64("plain") } }, html.payload],
            },
        };
        expect(messageText(both)).toBe("plain");
    });

    it("cannot be tricked into extra headers", () => {
        const raw = Buffer.from(
            rawMessage({ to: "a@b.c\r\nBcc: evil@x.y", subject: "s", body: "b" }),
            "base64url",
        ).toString();
        expect(raw).not.toMatch(/^Bcc:/m);
    });
});
