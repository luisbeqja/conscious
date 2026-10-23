import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A file in the app chat. Its bytes live on the host and are fetched by id. */
export interface AppFile {
    id: string;
    name: string;
    mimeType: string;
    size: number;
}

/** One bubble in the app: what the phone shows, not what the model saw. */
export interface AppEntry {
    id: string;
    role: "user" | "assistant";
    text: string;
    /** ISO time. */
    at: string;
    files?: AppFile[];
    /** The agent's reaction to a user message. */
    reaction?: string;
}

const KEEP = 500;
const MAX_FILE_BYTES = 20_000_000;

/**
 * What the app shows, per user: the agent's own conversation holds tool calls and turn
 * context, so the app keeps its own transcript of the bubbles. Files sit beside it.
 */
export class AppLog {
    private readonly cache = new Map<string, AppEntry[]>();

    constructor(private readonly dir: string) {}

    entries(userId: string): AppEntry[] {
        const cached = this.cache.get(userId);
        if (cached) return cached;
        const file = this.file(userId);
        const entries = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as AppEntry[]) : [];
        this.cache.set(userId, entries);
        return entries;
    }

    add(userId: string, entry: Omit<AppEntry, "id" | "at"> & { at?: Date }): AppEntry {
        const saved: AppEntry = { ...entry, id: randomUUID(), at: (entry.at ?? new Date()).toISOString() };
        this.save(userId, [...this.entries(userId), saved].slice(-KEEP));
        return saved;
    }

    /** Empties the user's chat and deletes its files. */
    clear(userId: string): void {
        this.cache.set(userId, []);
        rmSync(this.userDir(userId), { recursive: true, force: true });
    }

    react(userId: string, entryId: string, emoji: string): void {
        this.save(
            userId,
            this.entries(userId).map((entry) => (entry.id === entryId ? { ...entry, reaction: emoji } : entry)),
        );
    }

    /** When the user last wrote in the app, to send notifications where they are. */
    lastUserMessageAt(userId: string): Date | undefined {
        const last = this.entries(userId).findLast((entry) => entry.role === "user");
        return last ? new Date(last.at) : undefined;
    }

    storeFile(userId: string, name: string, mimeType: string, data: Uint8Array): AppFile {
        if (data.byteLength > MAX_FILE_BYTES) throw new Error("file too big");
        const file: AppFile = { id: randomUUID(), name, mimeType, size: data.byteLength };
        const dir = join(this.userDir(userId), "files");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(join(dir, file.id), data, { mode: 0o600 });
        writeFileSync(join(dir, `${file.id}.json`), JSON.stringify(file), { mode: 0o600 });
        return file;
    }

    /** A file of this user's, or undefined. Ids are checked so a path can never escape the folder. */
    readFile(userId: string, fileId: string): { file: AppFile; data: Buffer } | undefined {
        if (!/^[0-9a-f-]{36}$/.test(fileId)) return undefined;
        const path = join(this.userDir(userId), "files", fileId);
        if (!existsSync(path)) return undefined;
        const file = JSON.parse(readFileSync(`${path}.json`, "utf8")) as AppFile;
        return { file, data: readFileSync(path) };
    }

    private save(userId: string, entries: AppEntry[]): void {
        this.cache.set(userId, entries);
        const file = this.file(userId);
        mkdirSync(this.userDir(userId), { recursive: true, mode: 0o700 });
        const temporary = `${file}.tmp`;
        writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
        renameSync(temporary, file);
    }

    // User ids are phone numbers and emails, so the folder name is a hash of them.
    private userDir(userId: string): string {
        return join(this.dir, createHash("sha256").update(userId).digest("hex").slice(0, 16));
    }

    private file(userId: string): string {
        return join(this.userDir(userId), "chat.json");
    }
}
