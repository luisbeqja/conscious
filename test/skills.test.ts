import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    createModels,
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundAgents } from "../src/agents/background-agents.js";
import { createRegistry } from "../src/capabilities/index.js";
import { SandboxConversationStore } from "../src/conversations/sandbox-store.js";
import type { ModelRuntime } from "../src/engine/models.js";
import { Orchestrator } from "../src/engine/orchestrator.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { DEFAULT_BUNDLED_DIR, readBundledSkills, SkillLibrary } from "../src/skills/library.js";
import { parseSkillFile } from "../src/skills/skill-file.js";
import { FakeSandbox, FakeSandboxes } from "./fake-sandbox.js";

const JSON_STYLE = `---
name: weather
description: "Current weather and forecasts."
metadata:
  {
    "other-agent":
      {
        "emoji": "☔",
        "requires": { "bins": ["curl"] },
      },
  }
---

# Weather
`;

const CREDENTIAL_STYLE = `---
name: google-workspace
description: "Gmail, Calendar, Drive."
platforms: [linux, macos, windows]
required_credential_files:
  - path: google_token.json
    description: Google OAuth2 token
metadata:
  other-agent:
    requires_toolsets: [terminal]
---
`;

const skill = (name: string, front: string, body = "Do the thing.") =>
    `---\nname: ${name}\ndescription: ${name} things.\n${front}---\n\n${body}\n`;

/** A repo `skills/` folder on disk, built from path → content. */
const bundledDir = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "conscious-skills-"));
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
    }
    return dir;
};

/** A computer where only `curl` is installed. */
const computer = () =>
    new FakeSandbox((command) => ({
        exitCode: 0,
        stdout: command.includes("'curl'") ? "curl\n" : "",
        stderr: "",
    }));

describe("SKILL.md", () => {
    it("reads requirements under another agent's key, trailing commas and all", () => {
        expect(parseSkillFile(JSON_STYLE, "weather")).toEqual({
            name: "weather",
            description: "Current weather and forecasts.",
            requires: { bins: ["curl"], anyBins: [], external: [], os: [] },
        });
    });

    it("reads platforms and credential files", () => {
        const info = parseSkillFile(CREDENTIAL_STYLE, "google-workspace");
        expect(info?.requires.os).toEqual(["linux", "macos", "windows"]);
        expect(info?.requires.external).toEqual(["google_token.json"]);
    });

    it("rejects a file with no frontmatter, no description or a bad name", () => {
        expect(parseSkillFile("# Just text", "x")).toBeUndefined();
        expect(parseSkillFile("---\nname: x\n---\n", "x")).toBeUndefined();
        expect(parseSkillFile("---\nname: Bad Name\ndescription: d\n---\n", "x")).toBeUndefined();
    });
});

describe("SkillLibrary", () => {
    it("copies repo skills into the computer once, with a marker", async () => {
        const dir = bundledDir({
            "weather/SKILL.md": JSON_STYLE,
            "weather/scripts/get.sh": "curl wttr.in",
        });
        const library = new SkillLibrary({ bundledDir: dir, internet: true });
        const sandbox = computer();

        await library.sync("me", sandbox);
        expect(sandbox.files.get("/home/user/skills/weather/scripts/get.sh")).toBe("curl wttr.in");
        expect(sandbox.files.get("/home/user/skills/weather/.bundled")).toMatch(/^[0-9a-f]{16}$/);

        sandbox.files.set("/home/user/skills/weather/scripts/get.sh", "edited");
        await new SkillLibrary({ bundledDir: dir, internet: true }).sync("me", sandbox);
        expect(sandbox.files.get("/home/user/skills/weather/scripts/get.sh")).toBe("edited");
    });

    it("copies a skill again when the repo's version changes", async () => {
        const sandbox = computer();
        await new SkillLibrary({ bundledDir: bundledDir({ "weather/SKILL.md": JSON_STYLE }), internet: true }).sync(
            "me",
            sandbox,
        );
        const updated = `${JSON_STYLE}\nNew line.\n`;
        await new SkillLibrary({ bundledDir: bundledDir({ "weather/SKILL.md": updated }), internet: true }).sync(
            "me",
            sandbox,
        );
        expect(sandbox.files.get("/home/user/skills/weather/SKILL.md")).toBe(updated);
    });

    it("never overwrites a skill the user owns", async () => {
        const sandbox = computer();
        const mine = skill("weather", "", "My own way.");
        sandbox.files.set("/home/user/skills/weather/SKILL.md", mine);
        await new SkillLibrary({ bundledDir: bundledDir({ "weather/SKILL.md": JSON_STYLE }), internet: true }).sync(
            "me",
            sandbox,
        );
        expect(sandbox.files.get("/home/user/skills/weather/SKILL.md")).toBe(mine);
        expect(sandbox.files.has("/home/user/skills/weather/.bundled")).toBe(false);
    });

    it("lists only the skills that can run on this computer", async () => {
        const library = new SkillLibrary({
            bundledDir: bundledDir({
                "weather/SKILL.md": JSON_STYLE,
                "google-workspace/SKILL.md": CREDENTIAL_STYLE,
                "notes/SKILL.md": skill("notes", 'metadata:\n  conscious:\n    os: ["darwin"]\n'),
                "hue/SKILL.md": skill("hue", "metadata:\n  conscious:\n    requires:\n      bins: [openhue]\n"),
                "feeds/SKILL.md": skill("feeds", ""),
                "feeds/conscious.json": JSON.stringify({ internet: true }),
            }),
            internet: false,
        });
        const sandbox = computer();
        sandbox.files.set("/home/user/skills/packing/SKILL.md", skill("packing", ""));

        const names = (await library.list("me", sandbox)).map((listed) => listed.name);

        // weather needs only curl; packing is the user's own; the rest need a Mac, a secret,
        // a missing program, or the internet.
        expect(names).toEqual(["packing", "weather"]);
        expect(await library.render("me", sandbox)).toBe(
            "- `packing` (skills/packing/SKILL.md): packing things.\n- `weather` (skills/weather/SKILL.md): Current weather and forecasts.",
        );
    });

    it("asks the computer about each program once", async () => {
        const library = new SkillLibrary({
            bundledDir: bundledDir({ "weather/SKILL.md": JSON_STYLE }),
            internet: true,
        });
        const sandbox = computer();
        await library.list("me", sandbox);
        await library.list("me", sandbox);
        expect(sandbox.commands).toHaveLength(1);
    });

    it("loads every skill shipped in the repo", () => {
        for (const bundled of readBundledSkills(DEFAULT_BUNDLED_DIR)) {
            const info = parseSkillFile(bundled.files.get("SKILL.md") ?? "", bundled.name);
            expect(info?.name, bundled.name).toBe(bundled.name);
        }
    });
});

describe("skills in the prompt", () => {
    let scheduler: Scheduler | undefined;
    afterEach(() => scheduler?.stopAll());

    it("lists the computer's skills in the system prompt", async () => {
        const faux = fauxProvider();
        const models = createModels();
        models.setProvider(faux.provider);
        const runtime: ModelRuntime = {
            model: faux.getModel(),
            streamFn: (model, context, options) => models.streamSimple(model, context, options),
        };
        const sandboxes = new FakeSandboxes();
        sandboxes.sandboxes.set("me", computer());
        scheduler = new Scheduler(async () => {});
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
            skills: new SkillLibrary({
                bundledDir: bundledDir({ "weather/SKILL.md": JSON_STYLE }),
                internet: true,
            }),
        });
        let prompt = "";
        faux.setResponses([
            (context) => {
                prompt = getCurrentSystemPrompt(context.messages) ?? "";
                return fauxAssistantMessage(fauxText("Sunny."));
            },
        ]);

        await orchestrator.send("me", "weather in Rome?");

        expect(prompt).toContain("# Skills");
        expect(prompt).toContain("- `weather` (skills/weather/SKILL.md): Current weather and forecasts.");
    });
});
