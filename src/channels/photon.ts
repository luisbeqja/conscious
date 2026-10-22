import type { ContentInput, Message, Space } from "@spectrum-ts/core";
import { whatsappTemplate } from "@spectrum-ts/whatsapp-business";
import { type Chat, ChatBook } from "./chats.js";

/** The parts of the orchestrator a channel needs: answer a message, nothing else. */
export interface Answerer {
    send(userId: string, text: string, options: { react: (emoji: string) => Promise<boolean> }): Promise<string>;
}

const SEEN_LIMIT = 1000;

/** WhatsApp lets a business line write freely for 24 hours after the user's last message. A margin keeps sends from racing the edge. */
const WHATSAPP_WINDOW_MS = 23.5 * 60 * 60_000;
const WHATSAPP = "whatsapp_business";

/** A message template approved in Meta's WhatsApp Manager, with one `{{1}}` body variable for the text. */
export interface WhatsAppTemplate {
    name: string;
    languageCode: string;
}

export interface PhotonChannelOptions {
    /** Saves where each user writes from, so Conscious can still reach them after a restart. */
    chats?: ChatBook;
    /** Opens a saved chat again after a restart. */
    openSpace?: (platform: string, spaceId: string) => Promise<Space>;
    /** The only way to write on WhatsApp outside the 24-hour window. Without it such messages fail. */
    template?: WhatsAppTemplate;
    now?: () => Date;
}

/** Template variables may not hold line breaks, tabs or long runs of spaces, and the whole body is capped. */
export const templateParam = (text: string): string => {
    const flat = text
        .replace(/\s*\n\s*/g, " · ")
        .replace(/\s+/g, " ")
        .trim();
    return flat.length > 900 ? `${flat.slice(0, 899)}…` : flat;
};

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
    private readonly chats: ChatBook;
    private readonly now: () => Date;

    constructor(
        private readonly orchestrator: Answerer,
        allowedUsers: ReadonlySet<string>,
        private readonly options: PhotonChannelOptions = {},
    ) {
        this.allowedUsers = new Set([...allowedUsers].map(userIdOf));
        this.chats = options.chats ?? new ChatBook();
        this.now = options.now ?? (() => new Date());
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
        this.chats.wrote(userId, { platform: message.platform, spaceId: space.id, lastInboundAt: this.now() });

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

    /**
     * How Conscious speaks first: in the chat the user last wrote from, found again after a
     * restart. On WhatsApp, past the 24-hour window, the text goes inside the approved template.
     */
    notify = async (userId: string, text: string): Promise<void> => {
        const chat = this.chats.get(userId);
        const space = this.lastSpace.get(userId) ?? (chat ? await this.reopen(userId, chat) : undefined);
        if (!space || !chat) {
            console.warn(`[photon] ${userId} has never written, so there is no chat to send to; dropped: ${text}`);
            return;
        }
        await space.send(this.outbound(chat, text));
    };

    private outbound(chat: Chat, text: string): ContentInput {
        const quiet = this.now().getTime() - chat.lastInboundAt.getTime();
        if (chat.platform !== WHATSAPP || quiet < WHATSAPP_WINDOW_MS) return text;
        const { template } = this.options;
        if (!template) {
            console.warn(
                "[photon] the user last wrote over 24 hours ago, so WhatsApp will refuse this; set CONSCIOUS_WHATSAPP_TEMPLATE",
            );
            return text;
        }
        return whatsappTemplate({ ...template, bodyParams: [templateParam(text)] });
    }

    private async reopen(userId: string, chat: Chat): Promise<Space | undefined> {
        if (!this.options.openSpace) return undefined;
        try {
            const space = await this.options.openSpace(chat.platform, chat.spaceId);
            this.lastSpace.set(userId, space);
            return space;
        } catch (error) {
            console.error(`[photon] could not reopen the chat with ${userId}`, error);
            return undefined;
        }
    }

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
