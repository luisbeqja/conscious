import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxProvider } from "../sandbox/sandbox.js";

export interface Fact {
    id: string;
    text: string;
}

/** Someone in the user's life. */
export interface Person {
    id: string;
    name: string;
    /** Who they are to the user: "sister", "best friend", "landlord". */
    relation?: string;
    /** `MM-DD`, or `YYYY-MM-DD` when the year is known. */
    birthday?: string;
    notes: Fact[];
    /** The yearly nudges armed for the birthday, so a change can move them. */
    reminders?: string[];
}

/** What Conscious knows about one user, apart from the conversation. */
export interface Memory {
    about: Fact[];
    people: Person[];
}

export interface MemoryStore {
    load(userId: string): Promise<Memory>;
    save(userId: string, memory: Memory): Promise<void>;
}

export const emptyMemory = (): Memory => ({ about: [], people: [] });

export const newId = (): string => randomUUID().slice(0, 6);

const parse = (text: string | undefined): Memory => {
    if (!text) return emptyMemory();
    const saved = JSON.parse(text) as Partial<Memory>;
    return { about: saved.about ?? [], people: saved.people ?? [] };
};

export class InMemoryMemoryStore implements MemoryStore {
    private readonly memories = new Map<string, Memory>();

    async load(userId: string): Promise<Memory> {
        return structuredClone(this.memories.get(userId) ?? emptyMemory());
    }

    async save(userId: string, memory: Memory): Promise<void> {
        this.memories.set(userId, structuredClone(memory));
    }
}

/** Memory on the host's disk, for installs without a computer. Named by a hash, so no phone numbers show. */
export class FileMemoryStore implements MemoryStore {
    constructor(private readonly dir: string) {}

    async load(userId: string): Promise<Memory> {
        const file = this.file(userId);
        return existsSync(file) ? parse(await readFile(file, "utf8")) : emptyMemory();
    }

    async save(userId: string, memory: Memory): Promise<void> {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const file = this.file(userId);
        await writeFile(`${file}.tmp`, JSON.stringify(memory, null, 2), { mode: 0o600 });
        await rename(`${file}.tmp`, file);
    }

    private file(userId: string): string {
        return join(this.dir, `${createHash("sha256").update(userId).digest("hex").slice(0, 32)}.json`);
    }
}

export const SANDBOX_MEMORY_FILE = "memory/memory.json";

/** Memory on the user's own computer, next to their files and the conversation. */
export class SandboxMemoryStore implements MemoryStore {
    constructor(private readonly sandboxes: SandboxProvider) {}

    async load(userId: string): Promise<Memory> {
        return parse(await (await this.sandboxes.forUser(userId)).readFile(SANDBOX_MEMORY_FILE));
    }

    async save(userId: string, memory: Memory): Promise<void> {
        await (await this.sandboxes.forUser(userId)).writeFile(SANDBOX_MEMORY_FILE, JSON.stringify(memory, null, 2));
    }
}

export const isEmpty = (memory: Memory): boolean => memory.about.length === 0 && memory.people.length === 0;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `03-14` → "14 Mar", `1990-03-14` → "14 Mar 1990". */
export const formatBirthday = (birthday: string): string => {
    const [month, day, year] = parseBirthday(birthday) ?? [];
    if (!month || !day) return birthday;
    return [day, MONTHS[month - 1], year].filter(Boolean).join(" ");
};

/** [month, day, year?] from `MM-DD` or `YYYY-MM-DD`; undefined when it is not a real date. */
export const parseBirthday = (birthday: string): [number, number, number?] | undefined => {
    const match = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(birthday.trim());
    if (!match) return undefined;
    const [, year, month, day] = match.map(Number);
    if (!month || !day || month > 12 || day > new Date(Date.UTC(2024, month, 0)).getUTCDate()) return undefined;
    return year ? [month, day, year] : [month, day];
};

// Read into every prompt; past this the rest is left out of the prompt, though still kept.
const MAX_CHARS = 8_000;

/** Memory as the model reads it, ids included so it can forget a line. */
export const renderMemory = (memory: Memory): string => {
    if (isEmpty(memory)) return "Nothing yet.";
    const lines: string[] = [];
    if (memory.about.length) {
        lines.push("About them:", ...memory.about.map((fact) => `- ${fact.text} (#${fact.id})`));
    }
    if (memory.people.length) {
        lines.push("People in their life:");
        for (const person of memory.people) {
            const details = [person.relation, person.birthday && `birthday ${formatBirthday(person.birthday)}`];
            lines.push(`- ${[person.name, ...details].filter(Boolean).join(", ")} (#${person.id})`);
            lines.push(...person.notes.map((note) => `  - ${note.text} (#${note.id})`));
        }
    }
    const text = lines.join("\n");
    return text.length <= MAX_CHARS
        ? text
        : `${text.slice(0, MAX_CHARS)}\n…(cut: forget what no longer matters, or merge notes)`;
};
