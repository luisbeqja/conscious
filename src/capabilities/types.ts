import type { Static, TSchema } from "typebox";
import type { BackgroundAgents } from "../agents/background-agents.js";
import type { OutgoingFile } from "../media/incoming.js";
import type { Scheduler } from "../scheduler/scheduler.js";

/**
 * What a tool does in the user's life. The engine enforces it, not the prompt:
 * `read` and `draft` run freely, `commit` (sends, books, pays, deletes) needs the user's yes first.
 */
export type Effect = "read" | "draft" | "commit";

export interface ToolContext {
    userId: string;
    timezone: string;
    scheduler: Scheduler;
    /** Absent inside a background agent: sub-agents do not spawn sub-agents. */
    background?: BackgroundAgents;
    /** The background task this agent is working on. Only inside one. */
    task?: { id: string; tellUser(text: string): Promise<void> };
    /** The notebook of the agent doing this job. Only for the agent that writes the job's answer. */
    notebook?: { save(notes: string): Promise<void> };
    /** The last messages of the chat, handed to a background task so it knows what led to it. */
    recentChat?: string;
    /** Reacts to the message being answered; false when the chat cannot show it. Absent where there is none. */
    react?: (emoji: string) => Promise<boolean>;
    /** Sends a file into the user's chat. Only while answering a message on a channel that can. */
    sendFile?: (file: OutgoingFile) => Promise<void>;
    signal?: AbortSignal;
}

export interface ToolOutput {
    data: unknown;
    /** A rule that applies to this result only, read by the model beside the data. */
    guidance?: string;
}

export interface RegisteredTool<TParams extends TSchema = TSchema> {
    /** `<capability>_<verb>_<noun>`. */
    name: string;
    label: string;
    description: string;
    parameters: TParams;
    effect: Effect;
    execute(params: Static<TParams>, context: ToolContext): Promise<ToolOutput>;
}

export interface Capability {
    id: string;
    /** One line in the index the orchestrator always sees. */
    summary: string;
    /** How to use the tools well, loaded with them. */
    skill: string;
    tools: RegisteredTool[];
    /** A capability backed by a connector is offered only once the user has connected it. */
    available?(userId: string): Promise<boolean> | boolean;
}

export const defineTool = <TParams extends TSchema>(tool: RegisteredTool<TParams>): RegisteredTool =>
    tool as unknown as RegisteredTool;
