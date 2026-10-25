import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SEND_MESSAGE } from "../capabilities/chat/capability.js";

/**
 * One continuous conversation per user: there are no threads to pick.
 * Swap the in-memory store for a durable one before anyone depends on Conscious remembering.
 */
export interface ConversationStore {
    load(userId: string): Promise<AgentMessage[]>;
    save(userId: string, messages: AgentMessage[]): Promise<void>;
}

// Older turns cost tokens on every message; a memory layer, not the transcript, is what keeps facts.
export const MAX_MESSAGES = 200;

export class InMemoryConversationStore implements ConversationStore {
    private readonly conversations = new Map<string, AgentMessage[]>();

    async load(userId: string): Promise<AgentMessage[]> {
        return [...(this.conversations.get(userId) ?? [])];
    }

    async save(userId: string, messages: AgentMessage[]): Promise<void> {
        this.conversations.set(userId, trim(messages, MAX_MESSAGES));
    }
}

/** What a message's tool result says in the transcript, as the tool adapter writes it. */
const SENT = JSON.stringify({ data: { sent: true } });

/**
 * Before the message tool, a reply was the agent's last text, and the user saw it. Left as text, those
 * replies teach the model to answer in text again, which now reaches no one. So each one is shown as
 * what it would be today: a message it sent. Answers saved since never end in text (see `asSaid`), so
 * a text that ends a turn is always such a reply, even after a rollback.
 */
export const withSentReplies = (messages: readonly AgentMessage[]): AgentMessage[] =>
    messages.flatMap((message, index): AgentMessage[] => {
        const next = messages[index + 1];
        const reply =
            message.role === "assistant" &&
            message.stopReason === "stop" &&
            (!next || next.role === "user") &&
            !message.content.some((block) => block.type === "toolCall");
        if (!reply) return [message];
        const text = message.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n")
            .trim();
        if (!text) return [message];
        const id = `earlier_reply_${index}`;
        return [
            {
                ...message,
                stopReason: "toolUse",
                content: [
                    ...message.content.filter((block) => block.type !== "text"),
                    { type: "toolCall", id, name: SEND_MESSAGE, arguments: { text } },
                ],
            },
            {
                role: "toolResult",
                toolCallId: id,
                toolName: SEND_MESSAGE,
                content: [{ type: "text", text: SENT }],
                isError: false,
                timestamp: message.timestamp,
            },
        ];
    });

/**
 * What is kept of one answer: the user's message, the tools used, and the messages sent. The text the
 * agent wrote reached no one, and neither did the reminder to send; kept, they would show the model
 * replies written as text, the habit it must not pick up again.
 */
export const asSaid = (answer: readonly AgentMessage[]): AgentMessage[] =>
    answer.flatMap((message, index): AgentMessage[] => {
        // The first is the user's message; any later one is the reminder.
        if (message.role === "user") return index === 0 ? [message] : [];
        if (message.role !== "assistant") return [message];
        if (!message.content.some((block) => block.type === "toolCall")) return [];
        return [{ ...message, content: message.content.filter((block) => block.type !== "text") }];
    });

/** Cuts the oldest messages, but never starts the kept history on a tool result whose call was cut. */
export const trim = (messages: AgentMessage[], max: number): AgentMessage[] => {
    if (messages.length <= max) return messages;
    let start = messages.length - max;
    while (start < messages.length && messages[start]?.role !== "user") start++;
    return messages.slice(start);
};
