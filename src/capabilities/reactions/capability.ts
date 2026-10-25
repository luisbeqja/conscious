import { Type } from "typebox";
import { promptFile } from "../../prompts/prompt-file.js";
import { type Capability, defineTool } from "../types.js";

const react = defineTool({
    name: "reactions_react_message",
    label: "React to the message",
    description:
        "Put an emoji reaction on the message the user just sent. Reacting again replaces the reaction. A reaction can be the whole answer: then send nothing.",
    effect: "draft",
    parameters: Type.Object({
        emoji: Type.String({ description: "One emoji, e.g. 👍 ❤️ 😂 👀 🙏" }),
    }),
    execute: async (params, context) => {
        if (!context.react)
            return { data: { reacted: false }, guidance: "This chat has no reactions. Answer in words." };
        const reacted = await context.react(params.emoji.trim());
        return reacted
            ? { data: { reacted: true } }
            : { data: { reacted: false }, guidance: "The reaction did not go through. Answer in words." };
    },
});

export const reactionsCapability: Capability = {
    id: "reactions",
    summary: "React to the user's message with an emoji, before an answer or instead of one.",
    skill: promptFile(import.meta.url, "SKILL.md"),
    tools: [react],
};
