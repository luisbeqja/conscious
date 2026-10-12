import { Type } from "typebox";
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
                "Everything the sub-agent needs: the goal, what the user said, constraints, what a good answer looks like. It cannot see this conversation.",
        }),
    }),
    execute: async (params, context) => {
        const task = agents(context).spawn(context.userId, params.title, params.brief);
        return { data: { id: task.id, status: task.status } };
    },
});

const list = defineTool({
    name: "background_list_tasks",
    label: "List background tasks",
    description: "The user's background tasks: running and finished, with results.",
    effect: "read",
    parameters: Type.Object({}),
    execute: async (_params, context) => ({ data: agents(context).list(context.userId) }),
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
    tools: [start, list, cancel],
};
