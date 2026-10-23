import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/capabilities/types.js";
import { type McpServerEntry, readCatalog, selectServers } from "../src/mcp/catalog.js";
import { McpSignIn, McpUserServers, mcpConnector } from "../src/mcp/sign-in.js";
import { resolveConnector } from "../src/plugins/connectors.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { Vault } from "../src/vault/vault.js";

const entry: McpServerEntry = {
    name: "notes",
    title: "Notes",
    description: "The user's notes.",
    url: "https://mcp.notes.example/mcp",
    auth: "oauth",
    enabledByDefault: true,
    exclude: [],
    defaultEffect: "commit",
    effects: new Map([["find-notes", "read"]]),
};
const context: ToolContext = { userId: "me", timezone: "Europe/Rome", scheduler: new Scheduler(async () => {}) };
const REDIRECT = "https://me.example/vault/oauth/mcp-notes";

/** The authorization server: discovery, registration and the token endpoint. Counts what it is asked. */
const fakeAuth = () => {
    const seen = { registrations: 0, grants: [] as string[] };
    let issued = 0;
    const doFetch = (async (input: string | URL, init?: RequestInit) => {
        const url = new URL(input);
        if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
            return Response.json({
                resource: entry.url,
                authorization_servers: ["https://auth.notes.example"],
                scopes_supported: ["read", "write"],
            });
        }
        if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
            return Response.json({
                issuer: "https://auth.notes.example",
                authorization_endpoint: "https://auth.notes.example/authorize",
                token_endpoint: "https://auth.notes.example/token",
                registration_endpoint: "https://auth.notes.example/register",
                response_types_supported: ["code"],
                code_challenge_methods_supported: ["S256"],
                token_endpoint_auth_methods_supported: ["none"],
            });
        }
        if (url.pathname === "/register") {
            seen.registrations++;
            return Response.json({ ...JSON.parse(init?.body as string), client_id: "conscious-1" }, { status: 201 });
        }
        if (url.pathname === "/token") {
            const body = new URLSearchParams(init?.body as string);
            seen.grants.push(body.get("grant_type") ?? "");
            if (body.get("refresh_token") === "dead") return Response.json({ error: "invalid_grant" }, { status: 400 });
            issued++;
            return Response.json({
                access_token: `access-${issued}`,
                refresh_token: `refresh-${issued}`,
                token_type: "Bearer",
                expires_in: 3600,
            });
        }
        return new Response("not found", { status: 404 });
    }) as typeof fetch;
    return { seen, doFetch };
};

describe("signing in to an MCP server", () => {
    it("registers once, sends the user to the server's page with PKCE, and keeps the tokens", async () => {
        const vault = new Vault();
        const { seen, doFetch } = fakeAuth();
        const signIn = new McpSignIn(entry, REDIRECT, vault, doFetch);

        const first = new URL(await signIn.authUrl("state-one-1234567"));
        await signIn.authUrl("state-two-1234567");
        expect(seen.registrations).toBe(1);
        expect(first.origin + first.pathname).toBe("https://auth.notes.example/authorize");
        expect(first.searchParams.get("state")).toBe("state-one-1234567");
        expect(first.searchParams.get("code_challenge_method")).toBe("S256");
        expect(first.searchParams.get("redirect_uri")).toBe(REDIRECT);
        expect(first.searchParams.get("resource")).toBe(entry.url);

        vault.set("me", signIn.connector, await signIn.exchange("code-1", "state-one-1234567"));
        expect(await signIn.accessToken("me")).toBe("access-1");
        await expect(signIn.exchange("code-1", "state-one-1234567")).rejects.toThrow(/expired/);
    });

    it("refreshes when forced, saves the new tokens, and gives up on a dead refresh token", async () => {
        const vault = new Vault();
        const { seen, doFetch } = fakeAuth();
        const signIn = new McpSignIn(entry, REDIRECT, vault, doFetch);
        const save = (refresh: string) =>
            vault.set(
                "me",
                signIn.connector,
                JSON.stringify({
                    client: { client_id: "c" },
                    tokens: { access_token: "old", refresh_token: refresh, token_type: "Bearer" },
                    expiresAt: Date.now() - 1,
                }),
            );
        save("live");
        const [one, two] = await Promise.all([signIn.accessToken("me"), signIn.accessToken("me")]);
        expect([one, two]).toEqual(["access-1", "access-1"]);
        expect(seen.grants).toEqual(["refresh_token"]);
        expect(await signIn.accessToken("me")).toBe("access-1");

        save("dead");
        await expect(signIn.accessToken("me")).rejects.toThrow(/no longer accepts/);
    });

    it("keeps the sign-in away from plugins", () => {
        expect(mcpConnector(entry).id).toBe("mcp-notes");
        expect(resolveConnector({ connector: "mcp-notes" }).problems[0]).toMatch(/not built in/);
        expect(
            resolveConnector({
                connector: "mcp-notes",
                name: "N",
                hosts: ["mcp.notes.example"],
                howTo: { url: "https://x.example", steps: ["x"] },
                verifyUrl: "https://mcp.notes.example/mcp",
            }).connector,
        ).toBeDefined();
    });

    it("ships sign-in servers in the catalog, offered by default", () => {
        const offered = selectServers(readCatalog(), undefined).map((server) => `${server.name}:${server.auth}`);
        expect(offered).toEqual(
            expect.arrayContaining(["notion:oauth", "todoist:oauth", "strava:oauth", "dropbox:oauth", "kiwi:none"]),
        );
    });
});

describe("a signed-in user's MCP tools", () => {
    let http: HttpServer | undefined;
    afterEach(() => http?.close());

    /** A real MCP server over HTTP that only answers the bearer token it was told is current. */
    const notesServer = async (current: { token: string }) => {
        const authorizations: string[] = [];
        http = createServer(async (request, response) => {
            authorizations.push(request.headers.authorization ?? "");
            if (request.headers.authorization !== `Bearer ${current.token}`) {
                response.writeHead(401).end();
                return;
            }
            const server = new Server({ name: "notes", version: "1" }, { capabilities: { tools: {} } });
            server.setRequestHandler(ListToolsRequestSchema, async () => ({
                tools: [
                    { name: "find-notes", inputSchema: { type: "object" } },
                    { name: "delete-note", inputSchema: { type: "object" } },
                ],
            }));
            server.setRequestHandler(CallToolRequestSchema, async () => ({
                content: [{ type: "text", text: "Groceries: milk, eggs" }],
            }));
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await server.connect(transport);
            await transport.handleRequest(request, response);
        }).listen(0);
        await new Promise((resolve) => http?.once("listening", resolve));
        const local = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
        const toLocal = ((input: string | URL, init?: RequestInit) =>
            fetch(`${local}${new URL(input).pathname}`, init)) as typeof fetch;
        return { authorizations, toLocal };
    };

    it("offers tools only after sign-in, as the user, refreshing once when the server refuses", async () => {
        const vault = new Vault();
        const auth = fakeAuth();
        const signIn = new McpSignIn(entry, REDIRECT, vault, auth.doFetch);
        const current = { token: "access-1" };
        const { authorizations, toLocal } = await notesServer(current);
        const users = new McpUserServers([signIn], vault, toLocal);

        expect(await users.capabilities("me")).toEqual([]);
        vault.set(
            "me",
            signIn.connector,
            JSON.stringify({
                client: { client_id: "c" },
                tokens: { access_token: "stale", refresh_token: "live", token_type: "Bearer" },
            }),
        );
        const [notes] = await users.capabilities("me");
        expect(notes?.tools.map((tool) => [tool.name, tool.effect])).toEqual([
            ["notes_find_notes", "read"],
            ["notes_delete_note", "commit"],
        ]);
        expect(authorizations[0]).toBe("Bearer stale");
        expect(authorizations).toContain("Bearer access-1");

        const output = await notes?.tools[0]?.execute({}, context);
        expect(output?.data).toBe("Groceries: milk, eggs");
        expect(await users.capabilities("someone-else")).toEqual([]);
        await users.close();
    });

    it("forgets a sign-in the server no longer accepts, so the agent offers a new one", async () => {
        const vault = new Vault();
        const auth = fakeAuth();
        const signIn = new McpSignIn(entry, REDIRECT, vault, auth.doFetch);
        const { toLocal } = await notesServer({ token: "never" });
        const users = new McpUserServers([signIn], vault, toLocal);
        vault.set(
            "me",
            signIn.connector,
            JSON.stringify({
                client: { client_id: "c" },
                tokens: { access_token: "stale", refresh_token: "dead", token_type: "Bearer" },
            }),
        );
        expect(await users.capabilities("me")).toEqual([]);
        expect(await vault.credential("me", "mcp-notes")).toBeUndefined();
    });
});
