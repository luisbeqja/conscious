import { describe, expect, it } from "vitest";
import { createRegistry } from "../src/capabilities/index.js";
import { createHostSkillsCapability } from "../src/capabilities/skills/host-capability.js";
import type { ToolContext } from "../src/capabilities/types.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { readHostSkills } from "../src/skills/host.js";

const context: ToolContext = { userId: "me", timezone: "Europe/Rome", scheduler: new Scheduler(async () => {}) };

describe("Skills without a computer", () => {
    it("offers only the repo's skills that need no scripts and no files", () => {
        const names = readHostSkills().map((skill) => skill.name);
        expect(names).toEqual(expect.arrayContaining(["weather", "sunday-reset", "product-price-monitor"]));
        expect(names).not.toContain("rss-feeds");
        expect(names).not.toContain("watchers");
        expect(names).not.toContain("pdf");
    });

    it("lists them in the prompt and reads one on request", async () => {
        const capability = createHostSkillsCapability(readHostSkills());
        expect(capability.skill).toContain("`weather`");
        expect(capability.skill).toContain("web_read_page");
        const [read] = capability.tools;
        const output = await read?.execute({ name: "weather" }, context);
        expect((output?.data as { text: string }).text).toMatch(/^---\nname: weather/);
        expect((await read?.execute({ name: "nope" }, context))?.data).toMatchObject({
            error: expect.stringMatching(/Known/),
        });
    });

    it("is what an install without a computer gets", async () => {
        const ids = (await createRegistry().available("me")).map((capability) => capability.id);
        expect(ids).toContain("skills");
    });
});
