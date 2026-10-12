import { Type } from "typebox";
import { promptFile } from "../../prompts/prompt-file.js";
import { type Capability, defineTool } from "../types.js";

const create = defineTool({
    name: "reminders_create_reminder",
    label: "Set a reminder",
    description:
        "Schedule a WhatsApp message to the user. Give `at` for a one-off (ISO 8601 with the offset) or `cron` for a recurring one, never both.",
    effect: "draft",
    parameters: Type.Object({
        text: Type.String({ description: "The message to send, written to the user as you would say it." }),
        at: Type.Optional(Type.String({ description: "ISO 8601 with offset, e.g. 2026-10-13T09:00:00+02:00" })),
        cron: Type.Optional(Type.String({ description: "5-field cron in the user's timezone, e.g. '0 8 * * 1-5'" })),
    }),
    execute: async (params, context) => {
        const reminder = context.scheduler.add({
            userId: context.userId,
            text: params.text,
            at: params.at ? new Date(params.at) : undefined,
            cron: params.cron,
            timezone: context.timezone,
        });
        const [listed] = context.scheduler.list(context.userId).filter((entry) => entry.id === reminder.id);
        return { data: { id: reminder.id, nextRun: listed?.nextRun } };
    },
});

const list = defineTool({
    name: "reminders_list_reminders",
    label: "List reminders",
    description: "Every reminder the user has, with when it fires next.",
    effect: "read",
    parameters: Type.Object({}),
    execute: async (_params, context) => ({ data: context.scheduler.list(context.userId) }),
});

const cancel = defineTool({
    name: "reminders_cancel_reminder",
    label: "Cancel a reminder",
    description: "Cancel a reminder by id. List first if you do not have the id.",
    effect: "draft",
    parameters: Type.Object({ id: Type.String() }),
    execute: async (params, context) => ({ data: { cancelled: context.scheduler.cancel(context.userId, params.id) } }),
});

export const remindersCapability: Capability = {
    id: "reminders",
    summary: "Schedule messages to the user: one-off reminders and recurring ones.",
    skill: promptFile(import.meta.url, "SKILL.md"),
    tools: [create, list, cancel],
};
