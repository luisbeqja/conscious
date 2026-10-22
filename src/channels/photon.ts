import type { Message, Space } from "@spectrum-ts/core";

/** The parts of the orchestrator a channel needs: answer a message, nothing else. */
export interface Answerer {
    send(userId: string, text: string, options: { react: (emoji: string) => Promise<boolean> }): Promise<string>;
}

const SEEN_LIMIT = 1000;

/**
 * One id per person across platforms. WhatsApp reports a number as bare digits
 * (393331234567) while iMessage and the allow list use E.164 (+39 333 123 4567),
 * so phone numbers become "+" and digits; an Apple ID email is only lowercased.
 */
export const userIdOf = (sender: string): string => {
    const trimmed = sender.trim();
    if (/^\+?[\d\s().-]+$/.test(trimmed)) return `+${trimmed.replace(/\D/g, "")}`;
    return trimmed.toLowerCase();
};

/**
 * Conscious on Photon Spectrum: iMessage and WhatsApp through one message stream.
 * A user is their sender id (phone number or Apple ID), so the same person on two
 * platforms is one conversation. Replies and notifications go to the chat they last wrote from.
 */
export class PhotonChannel {
    private readonly lastSpace = new Map<string, Space>();
    // Delivery is at-least-once; a redelivered message must not be answered twice.
    private readonly seen = new Set<string>();

    private readonly allowedUsers: ReadonlySet<string>;

    constructor(
        private readonly orchestrator: Answerer,
        allowedUsers: ReadonlySet<string>,
    ) {
        this.allowedUsers = new Set([...allowedUsers].map(userIdOf));
    }

    async listen(messages: AsyncIterable<[Space, Message]>): Promise<void> {
        for await (const [space, message] of messages) {
            // Not awaited: a slow answer for one user must not hold up everyone else.
            void this.handle(space, message).catch((error: unknown) => {
                console.error(`[photon] message ${message.id} failed`, error);
            });
        }
    }

    async handle(space: Space, message: Message): Promise<void> {
        const userId = message.sender?.id ? userIdOf(message.sender.id) : undefined;
        if (message.direction !== "inbound" || !userId) return;
        if (!this.allowedUsers.has(userId)) {
            // Without this line, a typo in CONSCIOUS_ALLOWED_USERS looks like Conscious being down.
            console.warn(`[photon] ignored ${message.platform} message from ${userId}: not in CONSCIOUS_ALLOWED_USERS`);
            return;
        }
        if (!this.markSeen(`${message.platform}:${message.id}`)) return;
        this.lastSpace.set(userId, space);

        if (message.content.type !== "text") {
            await space.send("I can only read text for now.");
            return;
        }
        const text = message.content.text;
        // `responding` shows the typing indicator, so no "working on it" message is needed.
        const react = async (emoji: string) => (await message.react(emoji)) !== undefined;
        const reply = await space.responding(() => this.orchestrator.send(userId, text, { react }));
        // Empty when a reaction was the whole answer.
        if (reply) await space.send(reply);
    }

    /** How Conscious speaks first. Only users who have written since startup can be reached. */
    notify = async (userId: string, text: string): Promise<void> => {
        const space = this.lastSpace.get(userId);
        if (!space) {
            console.warn(`[photon] no chat for ${userId} yet; dropped: ${text}`);
            return;
        }
        await space.send(text);
    };

    private markSeen(key: string): boolean {
        if (this.seen.has(key)) return false;
        this.seen.add(key);
        if (this.seen.size > SEEN_LIMIT) {
            const oldest = this.seen.values().next().value;
            if (oldest !== undefined) this.seen.delete(oldest);
        }
        return true;
    }
}
