import { Type } from "typebox";
import type { MacBridge } from "../../mac/server.js";
import { promptFile } from "../../prompts/prompt-file.js";
import { type Capability, defineTool } from "../types.js";

/** What of Claude Code's answer the agent reads. The rest is cut, so one long answer cannot fill its context. */
const MAX_ANSWER_CHARS = 10_000;

/** Claude Code on the user's own Mac, reached through conscious-mac. Offered once they linked one with /mac. */
export const createMacCapability = (bridge: MacBridge): Capability => ({
    id: "mac",
    summary: "Claude Code on the user's own Mac: work on their real files and projects, in the folders they allowed.",
    skill: promptFile(import.meta.url, "SKILL.md"),
    available: (userId) => bridge.status(userId) !== undefined,
    tools: [
        defineTool({
            name: "mac_check_status",
            label: "Check the Mac",
            description:
                "Whether the user's Mac is online, the folders Claude Code may work in, what it is doing now with its last steps, and the latest conversations with it, which a job can go on with.",
            effect: "read",
            parameters: Type.Object({}),
            execute: async (_params, context) => ({ data: bridge.status(context.userId) ?? { linked: false } }),
        }),
        defineTool({
            name: "mac_ask_claude_code",
            label: "Ask Claude Code on the Mac",
            description:
                "Give Claude Code on the user's Mac a job or a question in one of the allowed folders, and wait for its answer, which takes minutes.",
            effect: "draft",
            // The chat starts a background task for it instead of waiting.
            backgroundOnly: true,
            parameters: Type.Object({
                folder: Type.String({ description: "An allowed folder, by its name or path, from mac_check_status." }),
                message: Type.String({
                    description:
                        "What Claude Code should do or answer, written to a capable engineer who cannot see the chat: the goal, the user's words, what not to touch, and what to report back.",
                }),
                session: Type.Optional(
                    Type.String({
                        description:
                            "To go on with an earlier conversation, so Claude Code remembers that work: its session, from mac_check_status or an earlier answer.",
                    }),
                ),
                readOnly: Type.Optional(
                    Type.Boolean({
                        description:
                            "True when the user only asks something: Claude Code reads and answers, and changes nothing.",
                    }),
                ),
            }),
            execute: async (params, context) => {
                const answer = await bridge.ask(
                    context.userId,
                    {
                        folder: params.folder,
                        message: params.message,
                        session: params.session || undefined,
                        readOnly: params.readOnly,
                    },
                    context.signal,
                );
                const cut = answer.text.length > MAX_ANSWER_CHARS;
                return {
                    data: {
                        ...answer,
                        text: cut ? `${answer.text.slice(0, MAX_ANSWER_CHARS)}\n\n(cut here)` : answer.text,
                    },
                    guidance: answer.denied.length
                        ? "Claude Code was refused what is in `denied`: nobody can approve a prompt on the Mac from here. Tell the user what it wanted to do. They can allow it in Claude Code's settings on the Mac, or do it themselves."
                        : undefined,
                };
            },
        }),
    ],
});
