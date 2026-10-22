import { describe, expect, it } from "vitest";
import { createSkillsCapability } from "../src/capabilities/skills/capability.js";
import type { ToolContext } from "../src/capabilities/types.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { parseSkillFile } from "../src/skills/skill-file.js";
import { FakeSandboxes } from "./fake-sandbox.js";

const setup = () => {
    const sandboxes = new FakeSandboxes();
    let clock = Date.parse("2026-10-22T10:00:00Z");
    const capability = createSkillsCapability(sandboxes, () => {
        clock += 1000;
        return new Date(clock);
    });
    const context: ToolContext = { userId: "me", timezone: "Europe/Rome", scheduler: new Scheduler(async () => {}) };
    const call = async (name: string, params: Record<string, unknown>) => {
        const tool = capability.tools.find((candidate) => candidate.name === name);
        if (!tool) throw new Error(name);
        return (await tool.execute(params as never, context)).data as Record<string, unknown>;
    };
    return { sandboxes, call };
};

describe("learned skills", () => {
    it("saves a skill the library can read, keeping each earlier version", async () => {
        const { sandboxes, call } = setup();
        await call("skills_save_skill", {
            name: "plan-a-trip",
            description: 'How this user likes trips planned: trains first, "quiet" hotels.',
            instructions: "1. Check trains before flights.",
        });
        await call("skills_save_skill", {
            name: "plan-a-trip",
            description: "How this user likes trips planned.",
            instructions: "1. Check trains before flights.\n2. Ask about the budget once.",
        });

        const sandbox = await sandboxes.forUser("me");
        const current = sandbox.files.get("/home/user/skills/plan-a-trip/SKILL.md") ?? "";
        expect(parseSkillFile(current, "plan-a-trip")?.description).toBe("How this user likes trips planned.");
        expect(current).toContain("2. Ask about the budget once.");

        const { versions } = await call("skills_list_versions", { name: "plan-a-trip" });
        expect(versions).toEqual(["2026-10-22T10-00-01-000Z"]);
        expect(sandbox.commands).toContain("rm -f skills/plan-a-trip/.bundled");
    });

    it("restores an earlier version and keeps the one it replaced", async () => {
        const { sandboxes, call } = setup();
        await call("skills_save_skill", { name: "receipts", description: "File receipts.", instructions: "Old way." });
        await call("skills_save_skill", { name: "receipts", description: "File receipts.", instructions: "New way." });
        const [first] = (await call("skills_list_versions", { name: "receipts" })).versions as string[];

        await call("skills_restore_version", { name: "receipts", version: first });

        const sandbox = await sandboxes.forUser("me");
        expect(sandbox.files.get("/home/user/skills/receipts/SKILL.md")).toContain("Old way.");
        expect((await call("skills_list_versions", { name: "receipts" })).versions).toHaveLength(2);
    });

    it("refuses names that are not a plain folder name", async () => {
        const { call } = setup();
        await expect(
            call("skills_save_skill", { name: "../memory", description: "x", instructions: "x" }),
        ).rejects.toThrow("lowercase");
        await expect(call("skills_restore_version", { name: "receipts", version: "../../x" })).rejects.toThrow();
    });
});
