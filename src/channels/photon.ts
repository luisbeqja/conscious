import type { ContentInput, Message, Space } from "@spectrum-ts/core";
import { attachment } from "@spectrum-ts/core";
import { whatsappTemplate } from "@spectrum-ts/whatsapp-business";
import type { IncomingFile, OutgoingFile } from "../media/incoming.js";
import type { Transcriber } from "../media/transcribe.js";
import { type Chat, ChatBook } from "./chats.js";

/** The parts of the orchestrator a channel needs: answer a message, nothing else. */
export interface Answerer {
    send(
        userId: string,
        text: string,
        options: {
            react: (emoji: string) => Promise<boolean>;
            files?: IncomingFile[];
            sendFile?: (file: OutgoingFile) => Promise<void>;
        },
    ): Promise<string>;
}

const SEEN_LIMIT = 1000;
const MAX_INCOMING_BYTES = 20_000_000;

/** WhatsApp lets a business line write freely for 24 hours after the user's last message. A margin keeps sends from racing the edge. */
const WHATSAPP_WINDOW_MS = 23.5 * 60 * 60_000;
const WHATSAPP = "whatsapp_business";
/** WhatsApp hides the typing indicator after 25 seconds, so a long answer shows it again before then. */
const TYPING_REFRESH_MS = 20_000;

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
    /** Turns voice notes into text. Without it, Conscious says it cannot listen yet. */
    transcriber?: Transcriber;
    /** Shows "typing…" on WhatsApp for a message id. Spectrum's own indicator only reaches iMessage. */
    showWhatsAppTyping?: (messageId: string) => Promise<void>;
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

        const stopTyping = this.startWhatsAppTyping(message);
        try {
            await this.answer(userId, space, message);
        } finally {
            stopTyping();
        }
    }

    private async answer(userId: string, space: Space, message: Message): Promise<void> {
        const incoming = await this.read(message);
        if (typeof incoming === "string") {
            if (incoming) await space.send(incoming);
            return;
        }
        const { text, files } = incoming;
        // `responding` shows the typing indicator on iMessage; WhatsApp's is kept up by `handle`.
        const react = async (emoji: string) => (await message.react(emoji)) !== undefined;
        const sendFile = async (file: OutgoingFile) => {
            await space.send(attachment(Buffer.from(file.data), { name: file.name, mimeType: file.mimeType }));
        };
        const reply = await space.responding(() => this.orchestrator.send(userId, text, { react, files, sendFile }));
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

    /**
     * What the agent gets from a message: its text, with voice notes written out and files
     * attached. A string instead is the whole answer, sent without the agent.
     */
    private async read(message: Message): Promise<{ text: string; files: IncomingFile[] } | string> {
        const { content } = message;
        if (content.type === "text") return { text: content.text, files: [] };
        if (content.type === "reaction") return "";
        if (content.type === "voice") {
            const { transcriber } = this.options;
            if (!transcriber) return "I can't listen to voice notes on this install yet. Could you write it?";
            try {
                const said = await transcriber.transcribe(await content.read(), content.mimeType);
                if (!said) return "I couldn't make out that voice note. Could you say it again, or write it?";
                return { text: `(voice note) ${said}`, files: [] };
            } catch (error) {
                console.error("[photon] voice note failed", error);
                return "I couldn't listen to that voice note just now. Could you write it?";
            }
        }
        if (content.type === "attachment") {
            if ((content.size ?? 0) > MAX_INCOMING_BYTES) return "That file is too big for me (over 20 MB).";
            const data = await content.read();
            return { text: "", files: [{ name: content.name, mimeType: content.mimeType, data }] };
        }
        return "I can't open that kind of message yet. Text, voice notes, photos and files work.";
    }

    /** Keeps "typing…" up while a WhatsApp message is read and answered. A failure costs only the indicator. */
    private startWhatsAppTyping(message: Message): () => void {
        const show = this.options.showWhatsAppTyping;
        if (!show || message.platform !== WHATSAPP || message.content.type === "reaction") return () => {};
        const once = () =>
            show(message.id).catch((error: unknown) => {
                console.warn(`[photon] could not show typing for ${message.id}`, error);
            });
        void once();
        const timer = setInterval(once, TYPING_REFRESH_MS);
        return () => clearInterval(timer);
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
