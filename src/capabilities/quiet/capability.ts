import { Type } from "typebox";
import { promptFile } from "../../prompts/prompt-file.js";
import type { Pacing } from "../../scheduler/pacing.js";
import { type Capability, defineTool } from "../types.js";

/** The user asking for space: Conscious stops writing first until they are back. */
export const createQuietCapability = (pacing: Pacing): Capability => ({
    id: "quiet",
    summary: "Give the user space: hold the messages you would start on your own until a date, or start again.",
    skill: promptFile(import.meta.url, "SKILL.md"),
    tools: [
        defineTool({
            name: "quiet_pause_messages",
            label: "Give them space",
            description:
                "Hold every message you would send on your own (follow-ups, birthday nudges, scheduled checks) until `until`. Reminders the user set still come.",
            effect: "draft",
            parameters: Type.Object({
                until: Type.String({ description: "ISO 8601 with offset, e.g. 2026-11-02T08:00:00+01:00" }),
            }),
            execute: async (params, context) => {
                const until = new Date(params.until);
                if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
                    return { data: { error: "Give a time in the future." } };
                }
                pacing.pause(context.userId, until);
                return { data: { pausedUntil: until.toISOString() } };
            },
        }),
        defineTool({
            name: "quiet_resume_messages",
            label: "Start again",
            description: "End a pause early, so follow-ups, nudges and checks reach the user again.",
            effect: "draft",
            parameters: Type.Object({}),
            execute: async (_params, context) => ({ data: { resumed: pacing.resume(context.userId) } }),
        }),
    ],
});
