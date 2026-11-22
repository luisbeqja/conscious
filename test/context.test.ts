import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { BackgroundAgents } from "../src/agents/background-agents.js";
import { createRegistry } from "../src/capabilities/index.js";
import { type Capability, defineTool } from "../src/capabilities/types.js";
import { InMemoryConversationStore } from "../src/conversations/store.js";
import { withoutOldPages } from "../src/engine/context.js";
import type { ModelRuntime } from "../src/engine/models.js";
import { Orchestrator } from "../src/engine/orchestrator.js";
import { Scheduler } from "../src/scheduler/scheduler.js";

const page = (n: number) => `- button "Step ${n}" [ref=e${n}]\n${"- text: filler\n".repeat(200)}`;

/** A browser that answers every click with the next whole page, as the real one does. */
const fakeBrowser = (): Capability => {
    let clicks = 0;
    return {
        id: "fakebrowser",
        summary: "A browser.",
        skill: "",
        tools: [
            defineTool({
                name: "fakebrowser_click",
                label: "Click",
                description: "Click.",
                effect: "draft",
                parameters: Type.Object({}),
                execute: async () => {
                    clicks += 1;
                    return { data: { url: `https://anpr.example/${clicks}`, title: "ANPR", page: page(clicks) } };
                },
            }),
        ],
    };
};

describe("the browser's old pages", () => {
    it("are left out of what the model reads, keeping only the latest, and out of what is saved", async () => {
        const faux = fauxProvider();
        const models = createModels();
        models.setProvider(faux.provider);
        const runtime: ModelRuntime = {
            model: faux.getModel(),
            streamFn: (model, context, options) => models.streamSimple(model, context, options),
        };
        const seen: string[] = [];
        const click = (context: { messages: unknown[] }) => {
            seen.push(JSON.stringify(context.messages));
            return fauxAssistantMessage(fauxToolCall("fakebrowser_click", {}), { stopReason: "toolUse" });
        };
        faux.setResponses([
            click,
            click,
            click,
            (context) => {
                seen.push(JSON.stringify(context.messages));
                return fauxAssistantMessage(fauxToolCall("chat_send_message", { text: "Done." }), {
                    stopReason: "toolUse",
                });
            },
            fauxAssistantMessage([]),
        ]);
        const store = new InMemoryConversationStore();
        const scheduler = new Scheduler(async () => {});
        const orchestrator = new Orchestrator({
            registry: createRegistry(undefined, [fakeBrowser()]),
            store,
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
        await orchestrator.send("me", "get my certificate", { say: async () => {} });
        scheduler.stopAll();

        // After three clicks the model reads only the third page; the first two are a line each.
        const last = seen.at(-1) ?? "";
        expect(last).toContain("Step 3");
        expect(last).not.toContain("Step 1");
        expect(last).not.toContain("Step 2");
        expect(last).toContain("https://anpr.example/1");
        expect(last).toContain("read it again with browser_read_page");
        // The saved conversation keeps where it went, and no page.
        const saved = JSON.stringify(await store.load("me"));
        expect(saved).not.toContain("filler");
        expect(saved).toContain("https://anpr.example/3");
    });

    it("leaves other tool results, user messages and unparsable text alone", () => {
        const messages = [
            { role: "user", content: 'the word "page" in a message', timestamp: 1 },
            {
                role: "toolResult",
                toolCallId: "a",
                toolName: "web_read_page",
                content: [{ type: "text", text: '{"data":{"text":"a page of the web"}}' }],
                isError: false,
                timestamp: 2,
            },
            {
                role: "toolResult",
                toolCallId: "b",
                toolName: "x",
                content: [{ type: "text", text: 'not json "page"' }],
                isError: false,
                timestamp: 3,
            },
        ] as never;
        expect(withoutOldPages(messages, false)).toEqual(messages);
    });
});
