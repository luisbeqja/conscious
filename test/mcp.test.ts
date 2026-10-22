import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundAgents } from "../src/agents/background-agents.js";
import { createRegistry } from "../src/capabilities/index.js";
import type { ToolContext } from "../src/capabilities/types.js";
import { InMemoryConversationStore } from "../src/conversations/store.js";
import type { ModelRuntime } from "../src/engine/models.js";
import { Orchestrator } from "../src/engine/orchestrator.js";
import { type McpServerEntry, parseManifest, readCatalog, selectServers } from "../src/mcp/catalog.js";
import { connectServer, connectServers, toolName } from "../src/mcp/servers.js";
import { Scheduler } from "../src/scheduler/scheduler.js";

const entry = (overrides: Partial<McpServerEntry> = {}): McpServerEntry => ({
    name: "trips",
    description: "Trip search.",
    url: "https://mcp.example.com",
    auth: "none",
    enabledByDefault: true,
    exclude: [],
    defaultEffect: "commit",
    effects: new Map(),
    ...overrides,
});

/** A small MCP server in this process: three tools, one of which fails. */
const tripsServer = () => {
    const calls: string[] = [];
    const server = new Server({ name: "trips", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "search-flight",
                description: "Find flights.",
                inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
            },
            {
                name: "list-airports",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: true },
            },
            { name: "book-flight", description: "Book it.", inputSchema: { type: "object" } },
        ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        calls.push(request.params.name);
        if (request.params.name === "list-airports") return { content: [{ type: "text", text: "no" }], isError: true };
        return { content: [{ type: "text", text: `Flights to ${String(request.params.arguments?.to)}: FR123` }] };
    });
    const transport = () => {
        const [client, own] = InMemoryTransport.createLinkedPair();
        void server.connect(own);
        return client;
    };
    return { calls, transport };
};

const context: ToolContext = { userId: "me", timezone: "Europe/Rome", scheduler: new Scheduler(async () => {}) };

describe("the MCP catalog", () => {
    it("loads the repo's catalog, and connects only to servers without a sign-in by default", () => {
        const catalog = readCatalog();
        expect(catalog.map((server) => server.name)).toEqual(["alltrails", "kiwi", "trivago"]);
        expect(selectServers(catalog, undefined).map((server) => server.name)).toEqual(["kiwi", "trivago"]);
        expect(selectServers(catalog, "alltrails").map((server) => server.name)).toEqual(["alltrails"]);
        expect(selectServers(catalog, "none")).toEqual([]);
        expect(() => selectServers(catalog, "spotify")).toThrow("not in mcp/");
        expect(() => selectServers([entry({ name: "todoist", auth: "oauth" })], "todoist")).toThrow("not built yet");
    });

    it("refuses a manifest whose name does not match its folder, or that is not https", () => {
        const manifest = (name: string, url: string) =>
            `name: ${name}\ndescription: x\ntransport:\n  type: http\n  url: ${url}\n`;
        expect(() => parseManifest(manifest("kiwi", "https://a.b"), "other")).toThrow("folder");
        expect(() => parseManifest(manifest("kiwi", "http://a.b"), "kiwi")).toThrow("https");
        expect(parseManifest(`${manifest("kiwi", "https://a.b")}default_effect: read\n`, "kiwi").defaultEffect).toBe(
            "read",
        );
    });

    it("names tools <server>_<tool>", () => {
        expect(toolName("kiwi", "search-flight")).toBe("kiwi_search_flight");
        expect(toolName("kiwi", "Get Prices!")).toBe("kiwi_get_prices");
    });
});

describe("an MCP server's tools", () => {
    it("become a capability: effects from the manifest, then the server's hint, then the default", async () => {
        const server = tripsServer();
        const { capability, close } = await connectServer(
            entry({ effects: new Map([["search-flight", "read"]]) }),
            server.transport,
        );
        expect(capability.tools.map((tool) => [tool.name, tool.effect])).toEqual([
            ["trips_search_flight", "read"],
            ["trips_list_airports", "read"],
            ["trips_book_flight", "commit"],
        ]);

        const search = capability.tools[0];
        expect((await search?.execute({ to: "Lisbon" } as never, context))?.data).toBe("Flights to Lisbon: FR123");
        await expect(capability.tools[1]?.execute({} as never, context)).rejects.toThrow("no");
        await close();
    });

    it("offers only the tools the manifest lists", async () => {
        const { capability, close } = await connectServer(
            entry({ include: ["search-flight"] }),
            tripsServer().transport,
        );
        expect(capability.tools.map((tool) => tool.name)).toEqual(["trips_search_flight"]);
        await close();
    });

    it("leaves out a server that does not answer, without failing startup", async () => {
        const result = await connectServers([entry()], () => {
            throw new Error("offline");
        });
        expect(result.capabilities).toEqual([]);
    });
});

describe("MCP tools in a conversation", () => {
    let scheduler: Scheduler | undefined;
    afterEach(() => scheduler?.stopAll());

    it("runs a read tool and holds a commit tool for the user's yes", async () => {
        const server = tripsServer();
        const { capability, close } = await connectServer(
            entry({ effects: new Map([["search-flight", "read"]]) }),
            server.transport,
        );
        const faux = fauxProvider();
        const models = createModels();
        models.setProvider(faux.provider);
        const runtime: ModelRuntime = {
            model: faux.getModel(),
            streamFn: (model, ctx, options) => models.streamSimple(model, ctx, options),
        };
        scheduler = new Scheduler(async () => {});
        const orchestrator = new Orchestrator({
            registry: createRegistry(undefined, [capability]),
            store: new InMemoryConversationStore(),
            runtime,
            budgets: { maxTurnsPerRun: 10, maxToolCallsPerRun: 10, maxBackgroundAgents: 1 },
            timezone: "Europe/Rome",
            scheduler,
            background: new BackgroundAgents(
                async () => "",
                async () => {},
                1,
            ),
        });
        faux.setResponses([
            fauxAssistantMessage(fauxToolCall("trips_search_flight", { to: "Lisbon" }), { stopReason: "toolUse" }),
            fauxAssistantMessage(fauxToolCall("trips_book_flight", {}), { stopReason: "toolUse" }),
            fauxAssistantMessage(fauxText("FR123 is the one; I need your yes to book.")),
        ]);

        await orchestrator.send("me", "find and book me a flight to Lisbon");

        expect(server.calls).toEqual(["search-flight"]);
        await close();
    });
});
