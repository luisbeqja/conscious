import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Where a user last wrote from, and when: enough to write to them first, even after a restart. */
export interface Chat {
    /** Photon's platform name, e.g. "whatsapp_business" or "imessage". */
    platform: string;
    spaceId: string;
    lastInboundAt: Date;
}

type Saved = Record<string, { platform: string; spaceId: string; lastInboundAt: string }>;

export class ChatBook {
    private readonly chats = new Map<string, Chat>();

    /** Without a file, chats live in this process only. */
    constructor(private readonly file?: string) {
        if (file && existsSync(file)) {
            const saved = JSON.parse(readFileSync(file, "utf8")) as Saved;
            for (const [userId, chat] of Object.entries(saved)) {
                this.chats.set(userId, { ...chat, lastInboundAt: new Date(chat.lastInboundAt) });
            }
        }
    }

    get(userId: string): Chat | undefined {
        return this.chats.get(userId);
    }

    wrote(userId: string, chat: Chat): void {
        this.chats.set(userId, chat);
        if (!this.file) return;
        const saved: Saved = Object.fromEntries(
            [...this.chats].map(([id, entry]) => [id, { ...entry, lastInboundAt: entry.lastInboundAt.toISOString() }]),
        );
        mkdirSync(dirname(this.file), { recursive: true });
        const temporary = `${this.file}.tmp`;
        writeFileSync(temporary, JSON.stringify(saved, null, 2), { mode: 0o600 });
        renameSync(temporary, this.file);
    }
}
