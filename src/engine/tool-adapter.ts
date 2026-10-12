import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RegisteredTool, ToolContext } from "../capabilities/types.js";

const MAX_RESULT_CHARS = 16_000;

/** Wraps a capability's tool for the pi loop. The cap keeps one careless read from flooding the context. */
export const adaptTool = (tool: RegisteredTool, context: ToolContext): AgentTool => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (_toolCallId, params, signal) => {
        const output = await tool.execute(params as never, { ...context, signal });
        const text = JSON.stringify({ data: output.data, guidance: output.guidance });
        if (text.length > MAX_RESULT_CHARS) {
            throw new Error(`Result too large (${text.length} characters). Ask for less.`);
        }
        return { content: [{ type: "text" as const, text }], details: {} };
    },
});
