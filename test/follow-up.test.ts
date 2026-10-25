import { afterEach, describe, expect, it } from "vitest";
import { remindersCapability } from "../src/capabilities/reminders/capability.js";
import type { ToolContext } from "../src/capabilities/types.js";
import { Scheduler } from "../src/scheduler/scheduler.js";

describe("follow-ups", () => {
    const scheduler = new Scheduler(async () => {});
    afterEach(() => scheduler.stopAll());

    it("asks once, after the event, in a check that knows why it matters", async () => {
        const context: ToolContext = { userId: "me", timezone: "Europe/Rome", scheduler };
        const tool = remindersCapability.tools.find((candidate) => candidate.name === "reminders_follow_up");
        const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
        await tool?.execute(
            { about: "the Bending Spoons interview", at, context: "Their dream job; nervous about the live coding." },
            context,
        );

        const [followUp] = scheduler.list("me");
        expect(followUp).toMatchObject({ text: "How did the Bending Spoons interview go?", at: new Date(at) });
        expect(followUp?.cron).toBeUndefined();
        expect(followUp?.check).toContain("dream job");
        expect(followUp?.check).toContain("send nothing");
    });
});
