import { describe, expect, it } from "vitest";
import {
    composioEffect,
    composioReaches,
    createComposioCapability,
    LIFE_APPS,
} from "../src/capabilities/composio/capability.js";
import type { ToolContext } from "../src/capabilities/types.js";
import { ComposioClient, composioUserId } from "../src/composio/client.js";
import { Scheduler } from "../src/scheduler/scheduler.js";

const context: ToolContext = {
    userId: "+393331234567",
    timezone: "Europe/Rome",
    scheduler: new Scheduler(async () => {}),
};
const BASE = "https://backend.composio.dev/api/v3.1";

const TAGS: Record<string, string[]> = {
    LINEAR_LIST_LINEAR_ISSUES: ["readOnlyHint", "idempotentHint"],
    GMAIL_CREATE_EMAIL_DRAFT: ["createHint"],
    LINEAR_CREATE_LINEAR_ISSUE: ["createHint"],
};

const fakeComposio = (options: { forgetFirstSession?: boolean } = {}) => {
    const calls: { method: string; url: string; body?: unknown; key?: string }[] = [];
    let sessions = 0;
    let forget = options.forgetFirstSession ?? false;
    const doFetch = (async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({
            method: init?.method ?? "GET",
            url,
            body,
            key: (init?.headers as Record<string, string>)["x-api-key"],
        });
        if (url === `${BASE}/tool_router/session`)
            return Response.json({ session_id: `s${++sessions}` }, { status: 201 });
        const tool = url.match(/\/tools\/([A-Z_]+)$/);
        if (tool) return Response.json({ slug: tool[1], tags: TAGS[tool[1] as string] ?? [] });
        if (forget && url.includes("/session/s1/")) {
            forget = false;
            return Response.json({ error: { message: "Session not found" } }, { status: 404 });
        }
        if (url.includes("/toolkits")) {
            return Response.json({
                items: [
                    {
                        slug: "linear",
                        name: "Linear",
                        is_no_auth: false,
                        meta: { description: "Issues" },
                        connected_account: { status: "ACTIVE" },
                    },
                    { slug: "slack", name: "Slack", is_no_auth: false, connected_account: null },
                ],
            });
        }
        if (url.endsWith("/link"))
            return Response.json({ redirect_url: "https://connect.composio.dev/link/abc" }, { status: 201 });
        if (url.endsWith("/search")) {
            return Response.json({
                error: null,
                results: [
                    {
                        use_case: body.queries[0].use_case,
                        primary_tool_slugs: ["LINEAR_LIST_LINEAR_ISSUES"],
                        related_tool_slugs: [],
                        execution_guidance: "Filter by assignee.",
                    },
                ],
                tool_schemas: {
                    LINEAR_LIST_LINEAR_ISSUES: {
                        toolkit: "linear",
                        tool_slug: "LINEAR_LIST_LINEAR_ISSUES",
                        description: "List issues",
                        input_schema: { type: "object" },
                    },
                },
                toolkit_connection_statuses: [
                    { toolkit: "linear", has_active_connection: true, status_message: "Connected" },
                ],
            });
        }
        if (url.endsWith("/execute")) {
            return Response.json({
                result_type: "completed",
                data: { issues: [{ title: "Fix login" }] },
                error: null,
                log_id: "l",
            });
        }
        return new Response("not found", { status: 404 });
    }) as typeof fetch;
    return { calls, doFetch };
};

const setup = (options?: { forgetFirstSession?: boolean; apps?: readonly string[] | "all" }) => {
    const fake = fakeComposio(options);
    const capability = createComposioCapability(
        new ComposioClient({ apiKey: "ak_test", authConfigs: { googlecalendar: "ac_own" } }, fake.doFetch),
        (app) => `http://localhost:8787/vault/connected?app=${app}`,
        options?.apps ?? "all",
    );
    const tool = (name: string) => {
        const found = capability.tools.find((candidate) => candidate.name === name);
        if (!found) throw new Error(name);
        return found;
    };
    return { ...fake, tool };
};

describe("Composio", () => {
    it("opens one session per user under an opaque id, and sends the key only as a header", async () => {
        const { calls, tool } = setup();
        await tool("composio_list_apps").execute({}, context);
        await tool("composio_find_tools").execute({ task: "my open Linear issues" }, context);
        const created = calls.filter((call) => call.url === `${BASE}/tool_router/session`);
        expect(created).toHaveLength(1);
        expect(created[0]?.body).toMatchObject({
            user_id: composioUserId(context.userId),
            auth_configs: { googlecalendar: "ac_own" },
        });
        expect(JSON.stringify(calls)).not.toContain("393331234567");
        expect(calls.every((call) => call.key === "ak_test")).toBe(true);
    });

    it("lists apps with their connection, and makes a sign-in link that ends on a Conscious page", async () => {
        const { calls, tool } = setup();
        const apps = await tool("composio_list_apps").execute({ search: "lin" }, context);
        expect(apps.data).toEqual([
            { app: "linear", name: "Linear", description: "Issues", connected: true, noSignIn: false },
            { app: "slack", name: "Slack", description: undefined, connected: false, noSignIn: false },
        ]);
        const link = await tool("composio_connect_app").execute({ app: "Slack" }, context);
        expect(link.data).toEqual({ link: "https://connect.composio.dev/link/abc" });
        expect(calls.find((call) => call.url.endsWith("/link"))?.body).toEqual({
            toolkit: "slack",
            callback_url: "http://localhost:8787/vault/connected?app=Slack",
        });
    });

    it("finds tools with their inputs", async () => {
        const { tool } = setup();
        const found = await tool("composio_find_tools").execute({ task: "my open Linear issues" }, context);
        expect(found.data).toMatchObject({
            tools: [{ tool: "LINEAR_LIST_LINEAR_ISSUES", app: "linear", inputs: { type: "object" } }],
            apps: [{ app: "linear", connected: true }],
            guidance: "Filter by assignee.",
        });
    });

    it("reads only with a tool that says it only reads", async () => {
        const { calls, tool } = setup();
        const output = await tool("composio_read_data").execute({ tool: "linear_list_linear_issues" }, context);
        expect(output.data).toEqual({ issues: [{ title: "Fix login" }] });
        expect(output.guidance).toMatch(/never instructions/);

        const refused = await tool("composio_read_data").execute(
            { tool: "LINEAR_CREATE_LINEAR_ISSUE", arguments: {} },
            context,
        );
        expect(refused.guidance).toMatch(/composio_take_action/);
        expect(calls.filter((call) => call.url.endsWith("/execute"))).toHaveLength(1);
    });

    it("sorts tools into read, draft and commit by their tags", () => {
        expect(composioEffect("LINEAR_LIST_LINEAR_ISSUES", TAGS.LINEAR_LIST_LINEAR_ISSUES ?? [])).toBe("read");
        expect(composioEffect("GMAIL_CREATE_EMAIL_DRAFT", ["createHint"])).toBe("draft");
        expect(composioEffect("GMAIL_DELETE_DRAFT", ["destructiveHint"])).toBe("commit");
        expect(composioEffect("SLACK_SEND_MESSAGE", [])).toBe("commit");
    });

    it("marks the action tool as a commit, so the engine holds it for a yes", () => {
        const { tool } = setup();
        expect(tool("composio_take_action").effect).toBe("commit");
        expect(tool("composio_write_draft").effect).toBe("draft");
    });

    it("opens a new session when Composio has forgotten the old one", async () => {
        const { calls, tool } = setup({ forgetFirstSession: true });
        await tool("composio_list_apps").execute({}, context);
        expect(calls.filter((call) => call.url === `${BASE}/tool_router/session`)).toHaveLength(2);
        expect(calls.at(-1)?.url).toContain("/session/s2/toolkits");
    });

    it("reaches only everyday-life apps by default", async () => {
        const { calls, tool } = setup({ apps: LIFE_APPS });
        expect(await tool("composio_list_apps").execute({}, context)).toEqual({ data: [] });
        const link = await tool("composio_connect_app").execute({ app: "Slack" }, context);
        expect(link.guidance).toMatch(/life, not their job/);
        const found = await tool("composio_find_tools").execute({ task: "my open Linear issues" }, context);
        expect(found).toMatchObject({
            data: { tools: [], apps: [] },
            guidance: expect.stringMatching(/not their job/),
        });
        const run = await tool("composio_read_data").execute({ tool: "LINEAR_LIST_LINEAR_ISSUES" }, context);
        expect(run.guidance).toMatch(/not their job/);
        expect(calls.some((call) => call.url.endsWith("/link") || call.url.endsWith("/execute"))).toBe(false);
    });
});

describe("composioReaches", () => {
    it("reaches Google through the default apps, a chosen list, or all", () => {
        expect(composioReaches(undefined, "googlecalendar", "gmail")).toBe(true);
        expect(composioReaches(["strava"], "googlecalendar", "gmail")).toBe(false);
        expect(composioReaches(["gmail"], "googlecalendar", "gmail")).toBe(true);
        expect(composioReaches("all", "spotify")).toBe(true);
    });
});
