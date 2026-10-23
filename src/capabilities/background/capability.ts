import { Type } from "typebox";
import { MAX_LANES, MAX_UPDATES } from "../../agents/background-agents.js";
import { promptFile } from "../../prompts/prompt-file.js";
import { type Capability, defineTool, type ToolContext } from "../types.js";

const agents = (context: ToolContext) => {
    if (!context.background) throw new Error("Background tasks cannot start other background tasks.");
    return context.background;
};

const start = defineTool({
    name: "background_start_task",
    label: "Start a background task",
    description:
        "Hand a longer job to a sub-agent that works while you keep talking. It messages the user itself when done.",
    effect: "draft",
    parameters: Type.Object({
        title: Type.String({ description: "A few words the user would recognise, e.g. 'Compare flights to Lisbon'." }),
        brief: Type.String({
            description:
                "Everything the sub-agent needs: the goal, what the user said, constraints, what a good answer looks like. It sees only the last few messages of this conversation.",
        }),
        instructions: Type.Optional(
            Type.String({
                description:
                    "Design the sub-agent for this job: its method, which sources to trust, what to compare, the order of steps, and what the final answer must contain. Becomes part of its system prompt.",
            }),
        ),
        capabilities: Type.Optional(
            Type.Array(Type.String(), {
                description:
                    "The ids of the capabilities it needs, from your index (e.g. web, a flights or hotels server). Leave out for all. Memory is always included.",
            }),
        ),
        lanes: Type.Optional(
            Type.Array(
                Type.Object({
                    title: Type.String({ description: "A few words, e.g. 'Flights from Milan'." }),
                    brief: Type.String({ description: "What this part covers and returns." }),
                }),
                {
                    maxItems: MAX_LANES,
                    description: `Split a job with independent parts (several dates, cities, shops or sources) into up to ${MAX_LANES} parts that run at the same time. A last agent puts their findings together into the answer.`,
                },
            ),
        ),
        effort: Type.Optional(
            Type.Union([Type.Literal("quick"), Type.Literal("long"), Type.Literal("deep")], {
                description:
                    "How much time and how many steps it gets: quick (10 min), long (30 min, the default), deep (60 min, many sources or options).",
            }),
        ),
    }),
    execute: async (params, context) => {
        const task = agents(context).spawn(context.userId, {
            title: params.title,
            brief: params.brief,
            effort: params.effort,
            harness: { instructions: params.instructions, capabilities: params.capabilities, lanes: params.lanes },
            recentChat: context.recentChat,
        });
        return {
            data: { id: task.id, status: task.status, effort: task.effort, parts: task.harness.lanes?.length ?? 0 },
        };
    },
});

const list = defineTool({
    name: "background_list_tasks",
    label: "List background tasks",
    description: "The user's background tasks: running and finished, with results.",
    effect: "read",
    parameters: Type.Object({}),
    execute: async (_params, context) => ({
        data: agents(context)
            .list(context.userId)
            .map(({ recentChat, ...task }) => task),
    }),
});

const message = defineTool({
    name: "background_message_task",
    label: "Tell a background task something",
    description:
        "Pass a change of plan or a new detail from the user to a running task, e.g. 'only morning flights'. It reads it after its current step.",
    effect: "draft",
    parameters: Type.Object({
        id: Type.String(),
        message: Type.String({ description: "What changed, in a sentence or two, with the user's words." }),
    }),
    execute: async (params, context) => ({
        data: { delivered: agents(context).message(context.userId, params.id, params.message) },
    }),
});

const cancel = defineTool({
    name: "background_cancel_task",
    label: "Cancel a background task",
    description: "Stop a running background task.",
    effect: "draft",
    parameters: Type.Object({ id: Type.String() }),
    execute: async (params, context) => ({ data: { cancelled: agents(context).cancel(context.userId, params.id) } }),
});

export const backgroundCapability: Capability = {
    id: "background",
    summary: "Run longer jobs (research, planning, comparing options) in the background while the chat goes on.",
    skill: promptFile(import.meta.url, "SKILL.md"),
    tools: [start, list, message, cancel],
};

const tellUser = defineTool({
    name: "task_tell_user",
    label: "Text the user an update",
    description: `Send the user a short message now, while you keep working: a first good find, or that it will take longer. At most ${MAX_UPDATES} per job; your final answer is sent anyway.`,
    effect: "draft",
    parameters: Type.Object({ text: Type.String({ description: "One or two short lines, the way a friend texts." }) }),
    execute: async (params, context) => {
        if (!context.task) throw new Error("Only a background task can send updates.");
        await context.task.tellUser(params.text);
        return { data: { sent: true } };
    },
});

/** What only a background agent gets: a way to speak before its job is done. */
export const taskCapability: Capability = {
    id: "task",
    summary: "You are working on a job in the background. You can text the user an update while you work.",
    skill: promptFile(import.meta.url, "TASK.md"),
    tools: [tellUser],
};
