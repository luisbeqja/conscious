import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundAgents } from "../src/agents/background-agents.js";
import { createRegistry } from "../src/capabilities/index.js";
import { InMemoryConversationStore } from "../src/conversations/store.js";
import type { ModelRuntime } from "../src/engine/models.js";
import { Orchestrator } from "../src/engine/orchestrator.js";
import type { RunProgress } from "../src/engine/run-agent.js";
import { CONNECTORS, type Connector } from "../src/plugins/connectors.js";
import { loadPluginFolder, type PluginDeps, pluginCapabilities } from "../src/plugins/plugins.js";
import { PluginInstalls, PluginRegistry } from "../src/plugins/registry.js";
import { NodeSandbox } from "../src/plugins/sandbox/sandbox.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { Vault } from "../src/vault/vault.js";

describe("plugins in the agent loop", () => {
    const scheduler = new Scheduler(async () => {});
    afterEach(() => scheduler.stopAll());

    it("finds and installs the GitHub plugin, uses it next message, and holds a write for a yes", async () => {
        const faux = fauxProvider();
        const models = createModels();
        models.setProvider(faux.provider);
        const runtime: ModelRuntime = {
            model: faux.getModel(),
            streamFn: (model, context, options) => models.streamSimple(model, context, options),
        };
        const requests: string[] = [];
        const vault = new Vault();
        vault.set("me", CONNECTORS.get("github") as Connector, "token-1");
        const plugins: PluginDeps = {
            registry: new PluginRegistry(),
            installs: new PluginInstalls(),
            sandbox: new NodeSandbox({ timeoutMs: 5_000 }),
            credentials: vault,
            transport: async (request) => {
                requests.push(`${request.method} ${request.url}`);
                return {
                    status: 200,
                    headers: {},
                    body: [
                        {
                            repository: { full_name: "octocat/hello-world" },
                            subject: { title: "Fix the README", type: "PullRequest" },
                            reason: "review_requested",
                            updated_at: "2026-10-12T09:00:00Z",
                        },
                    ],
                };
            },
        };
        const registry = createRegistry(undefined, [], {
            plugins,
            vault: { vault, publicUrl: "https://conscious.example.com" },
        }).addSource(pluginCapabilities(plugins));
        for (const pkg of loadPluginFolder(join(import.meta.dirname, "fixtures", "plugins"))) {
            plugins.registry.publish(pkg, { author: "conscious", source: "bundled" });
        }
        const orchestrator = new Orchestrator({
            registry,
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
            fauxAssistantMessage(fauxToolCall("plugins_search_plugins", { query: "github" }), {
                stopReason: "toolUse",
            }),
            fauxAssistantMessage(fauxToolCall("plugins_install_plugin", { id: "github" }), { stopReason: "toolUse" }),
            fauxAssistantMessage(fauxToolCall("chat_send_message", { text: "Installed GitHub." }), {
                stopReason: "toolUse",
            }),
            fauxAssistantMessage([]),
            fauxAssistantMessage(fauxToolCall("github_list_notifications", {}), { stopReason: "toolUse" }),
            fauxAssistantMessage(
                fauxToolCall("github_create_issue", { repo: "octocat/hello-world", title: "Thanks" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(
                fauxToolCall("chat_send_message", {
                    text: "One review request on hello-world. I need your yes to open the issue.",
                }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage([]),
        ]);

        expect(await orchestrator.send("me", "connect my github")).toEqual(["Installed GitHub."]);
        const progress: RunProgress[] = [];
        await orchestrator.send("me", "anything on github?", { onProgress: (p) => progress.push(p) });

        expect(progress).toContainEqual({ type: "tool", name: "github_list_notifications" });
        expect(requests).toEqual(["GET https://api.github.com/notifications?per_page=15"]);
    });
});
