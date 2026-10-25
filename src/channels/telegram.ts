import type { IncomingFile, OutgoingFile } from "../media/incoming.js";
import type { Transcriber } from "../media/transcribe.js";
import { bubblePauseMs, bubbles } from "./bubbles.js";
import { ChatBook } from "./chats.js";
import type { Answerer } from "./photon.js";
import { userIdOf } from "./user-id.js";
import { hearVoiceNote } from "./voice-notes.js";

/** Telegram's name in the chat book, beside Photon's "whatsapp_business" and "imessage". */
export const TELEGRAM = "telegram";

const API = "https://api.telegram.org";
/** How long one getUpdates call waits for a message before it is made again. */
const POLL_SECONDS = 50;
const RETRY_MS = 5_000;
/** Telegram shows "typing…" for five seconds, so a long answer shows it again before then. */
const TYPING_REFRESH_MS = 4_500;
/** The Bot API hands bots files up to 20 MB. */
const MAX_INCOMING_BYTES = 20_000_000;
const MAX_MESSAGE_CHARS = 4_096;
/** What sendPhoto takes, up to 10 MB; any other file goes as a document. */
const PHOTOS = new Set(["image/jpeg", "image/png"]);
const MAX_PHOTO_BYTES = 10_000_000;

interface TelegramFile {
    file_id: string;
    file_size?: number;
    file_name?: string;
    mime_type?: string;
}

/** The parts of a Bot API message Conscious reads. */
export interface TelegramMessage {
    message_id: number;
    from?: { id: number; username?: string };
    chat: { id: number; type: "private" | "group" | "supergroup" | "channel" };
    text?: string;
    caption?: string;
    voice?: TelegramFile;
    audio?: TelegramFile;
    document?: TelegramFile;
    /** One photo in several sizes, the largest last. */
    photo?: TelegramFile[];
    video?: TelegramFile;
    sticker?: { emoji?: string };
}

interface TelegramUpdate {
    update_id: number;
    message?: TelegramMessage;
}

/** A call the Bot API refused. The bot token is in the URL, so it never goes into the message. */
export class TelegramError extends Error {
    constructor(
        readonly method: string,
        readonly code: number,
        description: string,
    ) {
        super(`Telegram ${method} failed (${code}): ${description}`);
    }
}

/** The Bot API, as much of it as Conscious uses. */
export interface TelegramApi {
    /** One method. A file among the params goes up as an upload. */
    call<T = unknown>(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
    /** The bytes of a file the user sent. */
    download(fileId: string): Promise<Uint8Array>;
}

export const createTelegramApi = (token: string, doFetch: typeof fetch = fetch, base = API): TelegramApi => {
    const call = async <T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> => {
        const upload = Object.values(params).some((value) => value instanceof Blob);
        const form = new FormData();
        for (const [key, value] of upload ? Object.entries(params) : []) {
            if (value instanceof Blob) form.set(key, value);
            else if (value !== undefined) form.set(key, typeof value === "string" ? value : JSON.stringify(value));
        }
        // A long poll is answered only when its own timeout runs out.
        const waitMs = 30_000 + (typeof params.timeout === "number" ? params.timeout * 1000 : 0);
        const response = await doFetch(`${base}/bot${token}/${method}`, {
            method: "POST",
            headers: upload ? {} : { "content-type": "application/json" },
            body: upload ? form : JSON.stringify(params),
            signal: AbortSignal.any([AbortSignal.timeout(waitMs), ...(signal ? [signal] : [])]),
        });
        const reply = (await response.json().catch(() => ({}))) as {
            ok?: boolean;
            result?: T;
            error_code?: number;
            description?: string;
        };
        if (!reply.ok) {
            throw new TelegramError(
                method,
                reply.error_code ?? response.status,
                reply.description ?? response.statusText,
            );
        }
        return reply.result as T;
    };
    return {
        call,
        download: async (fileId) => {
            const { file_path: path } = await call<{ file_path?: string }>("getFile", { file_id: fileId });
            if (!path) throw new Error("Telegram gave no path for the file");
            const response = await doFetch(`${base}/file/bot${token}/${path}`, { signal: AbortSignal.timeout(60_000) });
            if (!response.ok) throw new Error(`Telegram file download failed (HTTP ${response.status})`);
            return new Uint8Array(await response.arrayBuffer());
        },
    };
};

/**
 * The agent writes *bold* the WhatsApp way (or **bold**). Telegram shows bold through HTML, so
 * everything else is escaped and only bold is marked up.
 */
export const telegramHtml = (text: string): string =>
    text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/(^|[\s(])(\*\*?)(?=\S)([^*\n]*?[^*\s])\2(?=$|[\s.,!?;:)])/gm, "$1<b>$3</b>");

/** Telegram takes up to 4,096 characters a message; a longer one goes in parts, cut at a line break or a space. */
export const pieces = (text: string): string[] => {
    const parts: string[] = [];
    let rest = text;
    while (rest.length > MAX_MESSAGE_CHARS) {
        const head = rest.slice(0, MAX_MESSAGE_CHARS);
        let cut = head.lastIndexOf("\n");
        if (cut < MAX_MESSAGE_CHARS / 2) cut = head.lastIndexOf(" ");
        if (cut <= 0) cut = MAX_MESSAGE_CHARS;
        parts.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).trimStart();
    }
    return [...parts, rest];
};

/** The file a message carries, named and typed even where Telegram leaves that out (photos). */
const attachmentOf = (message: TelegramMessage): (TelegramFile & { name: string; mimeType: string }) | undefined => {
    const photo = message.photo?.at(-1);
    if (photo) return { ...photo, name: "photo.jpg", mimeType: "image/jpeg" };
    const file = message.document ?? message.audio ?? message.video;
    return file && { ...file, name: file.file_name ?? "", mimeType: file.mime_type ?? "application/octet-stream" };
};

export interface TelegramChannelOptions {
    /** Saves where each user last wrote from, so Conscious can still reach them after a restart. */
    chats?: ChatBook;
    /** Turns voice notes into text. Without it, Conscious says it cannot listen yet. */
    transcriber?: Transcriber;
    now?: () => Date;
    /** Waits between two bubbles of one reply, and before asking Telegram again after an error. */
    pause?: (ms: number) => Promise<void>;
}

/**
 * Conscious as a Telegram bot, on the Bot API with long polling: each request waits at Telegram
 * until a message comes, so like Photon it needs no public address. Only the listed Telegram
 * users are answered, and only in their private chat with the bot.
 */
export class TelegramChannel {
    private readonly users: ReadonlyMap<string, string>;
    private readonly chats: ChatBook;
    private readonly now: () => Date;
    private readonly pause: (ms: number) => Promise<void>;

    /** `users` maps each Telegram user id to the user they are, written as on the other channels. */
    constructor(
        private readonly api: TelegramApi,
        private readonly orchestrator: Answerer,
        users: ReadonlyMap<string, string>,
        private readonly options: TelegramChannelOptions = {},
    ) {
        // A phone number is the same user however it is written, as on Photon's allow list.
        this.users = new Map([...users].map(([telegramId, userId]) => [telegramId, userIdOf(userId)]));
        this.chats = options.chats ?? new ChatBook();
        this.now = options.now ?? (() => new Date());
        this.pause = options.pause ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    }

    /** Takes messages until `signal` aborts. A refused token stops it; any other failure is tried again. */
    async listen(signal: AbortSignal): Promise<void> {
        let started = false;
        let offset: number | undefined;
        while (!signal.aborted) {
            try {
                if (!started) {
                    const me = await this.api.call<{ username?: string }>("getMe", {}, signal);
                    // getUpdates gets nothing while the bot has a webhook, such as one another tool set.
                    await this.api.call("deleteWebhook", {}, signal);
                    console.log(`[telegram] listening as @${me.username}`);
                    started = true;
                }
                const updates = await this.api.call<TelegramUpdate[]>(
                    "getUpdates",
                    { offset, timeout: POLL_SECONDS, allowed_updates: ["message"] },
                    signal,
                );
                for (const update of updates) {
                    // The next call's offset tells Telegram these arrived, so they do not come again.
                    offset = update.update_id + 1;
                    const { message } = update;
                    if (!message) continue;
                    // Not awaited: a slow answer for one user must not hold up everyone else.
                    void this.handle(message).catch((error: unknown) => {
                        console.error(`[telegram] message ${message.message_id} failed`, error);
                    });
                }
            } catch (error) {
                if (signal.aborted) return;
                if (error instanceof TelegramError && (error.code === 401 || error.code === 404)) {
                    console.error("[telegram] Telegram refused TELEGRAM_BOT_TOKEN; Telegram is off until it is fixed");
                    return;
                }
                // A 409 means another copy is asking for this bot's messages, as for a moment during a deploy.
                console.warn(
                    `[telegram] could not get messages, trying again in ${RETRY_MS / 1000} seconds:`,
                    error instanceof Error ? error.message : error,
                );
                await this.pause(RETRY_MS);
            }
        }
    }

    async handle(message: TelegramMessage): Promise<void> {
        const { from } = message;
        if (!from) return;
        const userId = this.users.get(String(from.id));
        if (!userId) {
            // Telegram's apps do not show the id, so this line is where to find it for the list.
            console.warn(
                `[telegram] ignored a message from ${from.id}${from.username ? ` (@${from.username})` : ""}: not in CONSCIOUS_TELEGRAM_USERS`,
            );
            return;
        }
        // In a group, everyone in it would read the answers.
        if (message.chat.type !== "private") {
            console.warn(
                `[telegram] ignored ${userId} in a ${message.chat.type} chat: Conscious answers only in private`,
            );
            return;
        }
        const chatId = String(message.chat.id);
        this.chats.wrote(userId, { platform: TELEGRAM, spaceId: chatId, lastInboundAt: this.now() });

        const stopTyping = this.startTyping(chatId);
        try {
            await this.answer(userId, chatId, message);
        } finally {
            stopTyping();
        }
    }

    /** How Conscious speaks first: in the user's chat with the bot, found again after a restart. */
    notify = async (userId: string, text: string): Promise<void> => {
        const chat = this.chats.get(userId);
        if (chat?.platform !== TELEGRAM) {
            console.warn(
                `[telegram] ${userId} has not written on Telegram, so there is no chat to send to; dropped: ${text}`,
            );
            return;
        }
        await this.sendBubbles(chat.spaceId, text);
    };

    private async answer(userId: string, chatId: string, message: TelegramMessage): Promise<void> {
        const incoming = await this.read(message);
        if (typeof incoming === "string") {
            if (incoming) await this.sendText(chatId, incoming);
            return;
        }
        const { text, files } = incoming;
        await this.orchestrator.send(userId, text, {
            // Each message goes out the moment the agent sends it, as short bubbles.
            say: (reply) => this.sendBubbles(chatId, reply),
            react: (emoji) => this.react(chatId, message.message_id, emoji),
            files,
            sendFile: (file) => this.sendFile(chatId, file),
        });
    }

    /**
     * What the agent gets from a message: its text or caption, with voice notes written out and
     * files attached. A string instead is the whole answer, sent without the agent.
     */
    private async read(message: TelegramMessage): Promise<{ text: string; files: IncomingFile[] } | string> {
        if (message.text !== undefined) {
            // Telegram sends /start when someone opens the bot for the first time.
            return { text: /^\/start(\s|$)/.test(message.text) ? "Hi!" : message.text, files: [] };
        }
        const { voice } = message;
        if (voice) {
            const audio = () => this.api.download(voice.file_id);
            return hearVoiceNote(this.options.transcriber, audio, voice.mime_type ?? "audio/ogg", "telegram");
        }
        const file = attachmentOf(message);
        if (file) {
            if ((file.file_size ?? 0) > MAX_INCOMING_BYTES) return "That file is too big for me (over 20 MB).";
            const data = await this.api.download(file.file_id);
            return { text: message.caption ?? "", files: [{ name: file.name, mimeType: file.mimeType, data }] };
        }
        if (message.sticker) return { text: `(sticker) ${message.sticker.emoji ?? ""}`.trim(), files: [] };
        return "I can't open that kind of message yet. Text, voice notes, photos and files work.";
    }

    /** A reply in short separate messages, the way a friend texts, with a moment between them. */
    private async sendBubbles(chatId: string, text: string): Promise<void> {
        for (const [index, part] of bubbles(text).entries()) {
            if (index > 0) await this.pause(bubblePauseMs(part));
            await this.sendText(chatId, part);
        }
    }

    private async sendText(chatId: string, text: string): Promise<void> {
        for (const piece of pieces(text)) {
            try {
                await this.api.call("sendMessage", { chat_id: chatId, text: telegramHtml(piece), parse_mode: "HTML" });
            } catch (error) {
                // If Telegram cannot read the formatting, the words still go, without it.
                if (!(error instanceof TelegramError && /can't parse entities/i.test(error.message))) throw error;
                await this.api.call("sendMessage", { chat_id: chatId, text: piece });
            }
        }
    }

    private async react(chatId: string, messageId: number, emoji: string): Promise<boolean> {
        try {
            // Telegram's reactions are a fixed set of emoji, written without the U+FE0F that "❤️" carries.
            await this.api.call("setMessageReaction", {
                chat_id: chatId,
                message_id: messageId,
                reaction: [{ type: "emoji", emoji: emoji.replace(/️/g, "") }],
            });
            return true;
        } catch (error) {
            console.warn(`[telegram] could not react with ${emoji}:`, error instanceof Error ? error.message : error);
            return false;
        }
    }

    private async sendFile(chatId: string, file: OutgoingFile): Promise<void> {
        const upload = new File([file.data as Uint8Array<ArrayBuffer>], file.name, { type: file.mimeType });
        if (PHOTOS.has(file.mimeType) && file.data.length <= MAX_PHOTO_BYTES) {
            await this.api.call("sendPhoto", { chat_id: chatId, photo: upload });
        } else {
            await this.api.call("sendDocument", { chat_id: chatId, document: upload });
        }
    }

    /** Keeps "typing…" up while a message is read and answered. A failure costs only the indicator. */
    private startTyping(chatId: string): () => void {
        const once = () =>
            this.api.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch((error: unknown) => {
                console.warn(`[telegram] could not show typing:`, error instanceof Error ? error.message : error);
            });
        void once();
        const timer = setInterval(once, TYPING_REFRESH_MS);
        return () => clearInterval(timer);
    }
}
