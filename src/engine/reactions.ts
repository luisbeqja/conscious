import { normalizeContext } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "./models.js";

/**
 * The emoji Conscious reacts with: the ones a friend uses, all in the fixed set Telegram
 * accepts, so a reaction works on every channel.
 */
export const REACTIONS = [
    "❤️",
    "👍",
    "👌",
    "🙏",
    "🔥",
    "🎉",
    "👏",
    "🏆",
    "💯",
    "🥰",
    "😍",
    "🤩",
    "😁",
    "🤣",
    "😎",
    "🤗",
    "🤝",
    "🫡",
    "😇",
    "😘",
    "🍾",
    "🤔",
    "🤯",
    "😱",
    "👀",
    "😢",
    "😭",
    "💔",
    "😴",
] as const;

const PROMPT = `You add emoji reactions to chat messages, the way a close friend would on WhatsApp or Telegram. You react for Conscious, a personal assistant that answers in words on its own: a reaction is only a small sign that the message landed.

Most messages get no reaction. React only when a friend naturally would:
- good news, something done, a plan that worked: 🎉 🔥 👏 🏆 💯
- thanks, or something kind or sweet: ❤️ 🥰 🙏
- something funny: 🤣 😁
- sad or hard news: 😢 💔 🤗
- "ok", "done", "deal", a yes to a question you asked: 👍 👌
- a photo of something lovely: 😍 🤩
No reaction for questions, requests, instructions, or a message that only carries on the conversation.

React to the last message from the User; the lines before it are only context. Answer with one emoji from this list and nothing else, or with the word none:
${REACTIONS.join(" ")}`;

const bare = (emoji: string): string => emoji.replace(/️/g, "");

/** Decides, apart from the answer, whether the user's message gets an emoji, and which. */
export interface Reactor {
    /** `recentChat` ends with the message to react to. Undefined: a friend would not react. */
    choose(recentChat: string): Promise<string | undefined>;
}

/** One short call to the model, without thinking: small enough to run beside every answer. */
export const createReactor = (runtime: ModelRuntime): Reactor => ({
    choose: async (recentChat) => {
        const context = normalizeContext({
            systemPrompt: PROMPT,
            messages: [{ role: "user", content: recentChat, timestamp: Date.now() }],
        });
        const reply = await (await runtime.streamFn(runtime.model, context, { maxTokens: 16 })).result();
        if (reply.stopReason === "error") throw new Error(reply.errorMessage ?? "the model failed");
        const said = bare(
            reply.content
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .join("")
                .trim(),
        );
        // Anything but one emoji from the list, "none" included, is no reaction.
        return REACTIONS.find((emoji) => bare(emoji) === said);
    },
});
