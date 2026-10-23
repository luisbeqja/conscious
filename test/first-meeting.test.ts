import { describe, expect, it } from "vitest";
import { buildBackgroundPrompt, buildSystemPrompt } from "../src/prompts/prompts.js";

describe("the first meeting", () => {
    it("asks a new user who they are and offers to look them up, only in the chat itself", () => {
        const first = buildSystemPrompt("", { memory: "Nothing yet.", firstMeeting: true });
        expect(first).toContain("You have only just met");
        expect(first).toMatch(/look you up online/);
        expect(buildSystemPrompt("", { memory: "About them:\n- Goes by Lu (#a1)" })).not.toContain(
            "You have only just met",
        );
        expect(buildBackgroundPrompt("", { memory: "Nothing yet.", firstMeeting: true })).not.toContain(
            "You have only just met",
        );
    });
});
