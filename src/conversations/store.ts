import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * One continuous conversation per user, as WhatsApp shows it: there are no threads to pick.
 * Swap the in-memory store for a durable one before anyone depends on Conscious remembering.
 */
export interface ConversationStore {
    load(userId: string): Promise<AgentMessage[]>;
    save(userId: string, messages: AgentMessage[]): Promise<void>;
    /** Has this channel message been handled already? Marks it handled if not. */
    claim(userId: string, messageId: string): Promise<boolean>;
}

// Older turns cost tokens on every message; a memory layer, not the transcript, is what keeps facts.
const MAX_MESSAGES = 200;

export class InMemoryConversationStore implements ConversationStore {
    private readonly conversations = new Map<string, AgentMessage[]>();
    private readonly seen = new Set<string>();

    async load(userId: string): Promise<AgentMessage[]> {
        return [...(this.conversations.get(userId) ?? [])];
    }

    async save(userId: string, messages: AgentMessage[]): Promise<void> {
        this.conversations.set(userId, trim(messages, MAX_MESSAGES));
    }

    async claim(userId: string, messageId: string): Promise<boolean> {
        const key = `${userId}:${messageId}`;
        if (this.seen.has(key)) return false;
        this.seen.add(key);
        return true;
    }
}

/** Cuts the oldest messages, but never starts the kept history on a tool result whose call was cut. */
export const trim = (messages: AgentMessage[], max: number): AgentMessage[] => {
    if (messages.length <= max) return messages;
    let start = messages.length - max;
    while (start < messages.length && messages[start]?.role !== "user") start++;
    return messages.slice(start);
};
