import { Type } from "typebox";
import { promptFile } from "../../prompts/prompt-file.js";
import { type Capability, defineTool } from "../types.js";

/** The only tool that reaches the user. Whatever an agent writes outside it, they never see. */
export const SEND_MESSAGE = "chat_send_message";

const send = defineTool({
    name: SEND_MESSAGE,
    label: "Message the user",
    description:
        "Send the user a message now, in the chat they use (WhatsApp, iMessage or the Conscious app). It is the only way they see anything you write. A blank line splits it into separate bubbles.",
    effect: "draft",
    // Two messages in one turn arrive in the order they were written.
    sequential: true,
    parameters: Type.Object({
        text: Type.String({ description: "The message, written the way a friend texts." }),
    }),
    execute: async (params, context) => {
        const text = params.text.trim();
        if (!text) return { data: { sent: false }, guidance: "The message was empty, so nothing was sent." };
        if (!context.say) throw new Error("Nothing you write can reach the user from here.");
        await context.say(text);
        // Read right before the model writes again, when it is most tempted to keep talking in text.
        return {
            data: { sent: true },
            guidance: `Delivered. To say more, send another ${SEND_MESSAGE}. Otherwise end here without writing anything: text you write is never delivered.`,
        };
    },
});

/** How every agent talks to the user, whatever the channel. */
export const chatCapability: Capability = {
    id: "chat",
    summary: "Message the user. It is the only way they see anything you write.",
    skill: promptFile(import.meta.url, "SKILL.md"),
    tools: [send],
};
