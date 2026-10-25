import { Type } from "typebox";
import { type AgentStore, dayIn } from "../../agents/resting-agents.js";
import { promptFile } from "../../prompts/prompt-file.js";
import { type Capability, defineTool } from "../types.js";

const agentName = Type.String({ description: "The agent's name, as in 'Your agents'." });

const unknown = (name: string) =>
    new Error(`There is no agent called "${name}". The ones the user has are listed under "Your agents".`);

/** The orchestrator's side of the agents: tell one what the user said, read what it knows, forget it. */
export const createAgentsCapability = (store: AgentStore): Capability => {
    const addNote = defineTool({
        name: "agents_add_note",
        label: "Tell an agent",
        description:
            "Pass the user's reaction to an agent's work into its notebook, for its next job: what they picked, what was wrong, what to do differently.",
        effect: "draft",
        parameters: Type.Object({
            agent: agentName,
            note: Type.String({
                description:
                    "One line, with the user's words where they matter, e.g. 'Booked the second one: direct, 30 € more than the one with a stop'.",
            }),
        }),
        execute: async (params, context) => {
            if (!(await store.load(context.userId, params.agent))) throw unknown(params.agent);
            await store.addNote(context.userId, params.agent, params.note, dayIn(context.timezone));
            return { data: { added: true } };
        },
    });

    const readNotes = defineTool({
        name: "agents_read_notes",
        label: "Read an agent's notebook",
        description: "What an agent knows: its method, its notebook and its last jobs.",
        effect: "read",
        parameters: Type.Object({ agent: agentName }),
        execute: async (params, context) => {
            const agent = await store.load(context.userId, params.agent);
            if (!agent) throw unknown(params.agent);
            const [notes, jobs] = await Promise.all([
                store.notes(context.userId, agent.name),
                store.runs(context.userId, agent.name),
            ]);
            return {
                data: { name: agent.name, description: agent.description, method: agent.method, notes, jobs },
            };
        },
    });

    const forget = defineTool({
        name: "agents_forget_agent",
        label: "Forget an agent",
        description:
            "Delete an agent with its notebook and log, when the user asks you to forget how you do that kind of job.",
        effect: "draft",
        parameters: Type.Object({ agent: agentName }),
        execute: async (params, context) => ({
            data: { forgotten: await store.forget(context.userId, params.agent) },
        }),
    });

    return {
        id: "agents",
        summary:
            "Your agents for background jobs: tell one what the user said about its work, read what it knows, forget it.",
        skill: promptFile(import.meta.url, "SKILL.md"),
        tools: [addNote, readNotes, forget],
    };
};

const saveNotes = defineTool({
    name: "notebook_save_notes",
    label: "Rewrite your notebook",
    description:
        "Rewrite your notebook for this kind of job. It replaces the old one, so keep what still holds and add what you learned this time.",
    effect: "draft",
    parameters: Type.Object({
        notes: Type.String({ description: "Markdown, short lines, at most about 40." }),
    }),
    execute: async (params, context) => {
        if (!context.notebook) throw new Error("Only the agent that writes this job's answer keeps the notebook.");
        await context.notebook.save(params.notes);
        return { data: { saved: true } };
    },
});

/** What only an agent writing a job's answer gets: its notebook, rewritten before it answers. */
export const notebookCapability: Capability = {
    id: "notebook",
    summary: "Your notebook for this kind of job. Rewrite it once, just before you finish.",
    skill: promptFile(import.meta.url, "NOTEBOOK.md"),
    tools: [saveNotes],
};
