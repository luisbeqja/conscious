import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ConversationStore, MAX_MESSAGES, trim } from "./store.js";

/**
 * Conversations on the host's disk, for installs without a computer, so a restart does not wipe
 * them. Files are named by a hash of the user id, so the folder lists no phone numbers.
 */
export class FileConversationStore implements ConversationStore {
    constructor(private readonly dir: string) {}

    async load(userId: string): Promise<AgentMessage[]> {
        const file = this.file(userId);
        if (!existsSync(file)) return [];
        return JSON.parse(await readFile(file, "utf8")) as AgentMessage[];
    }

    async save(userId: string, messages: AgentMessage[]): Promise<void> {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const file = this.file(userId);
        await writeFile(`${file}.tmp`, JSON.stringify(trim(messages, MAX_MESSAGES)), { mode: 0o600 });
        await rename(`${file}.tmp`, file);
    }

    private file(userId: string): string {
        return join(this.dir, `${createHash("sha256").update(userId).digest("hex").slice(0, 32)}.json`);
    }
}
