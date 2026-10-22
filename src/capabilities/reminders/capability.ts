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

const check = defineTool({
    name: "reminders_schedule_check",
    label: "Schedule a check",
    description:
        "Schedule an agent to do a job on its own, once (`at`) or on a schedule (`cron`): watch a price, check the news, a morning brief. It has your tools and messages the user only when it finds something worth telling.",
    effect: "draft",
    parameters: Type.Object({
        title: Type.String({ description: "A few words the user would recognise, e.g. 'Lisbon flight price'." }),
        job: Type.String({
            description:
                "Everything the agent needs, since it cannot see this chat: what to check, how, what counts as worth a message (e.g. 'only if under 120 EUR'), and what to compare with last time.",
        }),
        at: Type.Optional(Type.String({ description: "ISO 8601 with offset, for a one-off check" })),
        cron: Type.Optional(Type.String({ description: "5-field cron in the user's timezone, e.g. '0 9 * * *'" })),
    }),
    execute: async (params, context) => {
        const reminder = context.scheduler.add({
            userId: context.userId,
            text: params.title,
            check: params.job,
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
    description: "Every reminder and scheduled check the user has, with when it fires next.",
    effect: "read",
    parameters: Type.Object({}),
    execute: async (_params, context) => ({ data: context.scheduler.list(context.userId) }),
});

const cancel = defineTool({
    name: "reminders_cancel_reminder",
    label: "Cancel a reminder",
    description: "Cancel a reminder or scheduled check by id. List first if you do not have the id.",
    effect: "draft",
    parameters: Type.Object({ id: Type.String() }),
    execute: async (params, context) => ({ data: { cancelled: context.scheduler.cancel(context.userId, params.id) } }),
});

export const remindersCapability: Capability = {
    id: "reminders",
    summary:
        "Schedule messages to the user (one-off and recurring reminders) and checks an agent runs on its own (price watches, news, a morning brief).",
    skill: promptFile(import.meta.url, "SKILL.md"),
    tools: [create, check, list, cancel],
};
