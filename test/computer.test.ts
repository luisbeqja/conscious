import {
    createModels,
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
    getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundAgents } from "../src/agents/background-agents.js";
import { createRegistry } from "../src/capabilities/index.js";
import { SandboxConversationStore } from "../src/conversations/sandbox-store.js";
import type { ModelRuntime } from "../src/engine/models.js";
import { Orchestrator } from "../src/engine/orchestrator.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { FakeSandboxes } from "./fake-sandbox.js";

const setup = () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime: ModelRuntime = {
        model: faux.getModel(),
        streamFn: (model, context, options) => models.streamSimple(model, context, options),
    };
    const sandboxes = new FakeSandboxes();
    const scheduler = new Scheduler(async () => {});
    const orchestrator = new Orchestrator({
        registry: createRegistry(sandboxes),
        store: new SandboxConversationStore(sandboxes),
        runtime,
        budgets: { maxTurnsPerRun: 10, maxToolCallsPerRun: 10, maxBackgroundAgents: 1 },
        timezone: "Europe/Rome",
        scheduler,
        background: new BackgroundAgents(
            async () => "",
            async () => {},
            1,
        ),
        sandboxes,
    });
    return { faux, sandboxes, scheduler, orchestrator };
};

describe("Conscious's computer", () => {
    let scheduler: Scheduler | undefined;
    afterEach(() => scheduler?.stopAll());

    it("writes what it learns to memory in the sandbox, and reads it back next message", async () => {
        const app = setup();
        scheduler = app.scheduler;
        const prompts: string[] = [];
        app.faux.setResponses([
            (context) => {
                prompts.push(getCurrentSystemPrompt(context.messages) ?? "");
                return fauxAssistantMessage(
                    fauxToolCall("computer_write_file", {
                        path: "memory/MEMORY.md",
                        content: "- Sister: Anna, birthday 3 May",
                    }),
                    { stopReason: "toolUse" },
                );
            },
            fauxAssistantMessage(fauxText("Noted, Anna's birthday is 3 May.")),
            (context) => {
                prompts.push(getCurrentSystemPrompt(context.messages) ?? "");
                return fauxAssistantMessage(fauxText("3 May."));
            },
        ]);

        await app.orchestrator.send("me", "my sister Anna's birthday is 3 May");
        await app.orchestrator.send("me", "when is Anna's birthday?");

        const sandbox = await app.sandboxes.forUser("me");
        expect(sandbox.files.get("/home/user/memory/MEMORY.md")).toBe("- Sister: Anna, birthday 3 May");
        expect(prompts[0]).toContain("# What you remember about the user\n\nNothing yet.");
        expect(prompts[1]).toContain("- Sister: Anna, birthday 3 May");
        expect(prompts[0]).toContain("## computer");
    });

    it("keeps the conversation in the user's sandbox, apart from other users", async () => {
        const app = setup();
        scheduler = app.scheduler;
        app.faux.setResponses([fauxAssistantMessage(fauxText("Hi!"))]);
        await app.orchestrator.send("me", "hello");

        const saved = (await app.sandboxes.forUser("me")).files.get("/home/user/.conscious/conversation.json");
        expect(JSON.parse(saved ?? "[]")).toHaveLength(2);
        expect((await app.sandboxes.forUser("someone-else")).files.size).toBe(0);
    });

    it("runs commands in the sandbox and caps long output to its end", async () => {
        const app = setup();
        scheduler = app.scheduler;
        const sandbox = await app.sandboxes.forUser("me");
        sandbox.run = async (command) => {
            sandbox.commands.push(command);
            return { exitCode: 0, stdout: `${"x".repeat(10_000)}END`, stderr: "" };
        };
        let toolResult = "";
        app.faux.setResponses([
            fauxAssistantMessage(fauxToolCall("computer_run_command", { command: "python3 big.py" }), {
                stopReason: "toolUse",
            }),
            (context) => {
                const last = context.messages.at(-1);
                if (last?.role === "toolResult") {
                    toolResult = last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
                }
                return fauxAssistantMessage(fauxText("Done."));
            },
        ]);

        await app.orchestrator.send("me", "run big.py");

        expect(sandbox.commands).toEqual(["python3 big.py"]);
        expect(toolResult).toContain("characters cut");
        expect(toolResult).toContain("END");
        expect(toolResult.length).toBeLessThan(7_000);
    });
});
