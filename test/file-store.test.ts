import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { FileConversationStore } from "../src/conversations/file-store.js";

describe("FileConversationStore", () => {
    it("keeps a conversation across a restart, without phone numbers in file names", async () => {
        const dir = mkdtempSync(join(tmpdir(), "conscious-conversations-"));
        const messages = [{ role: "user", content: "hi", timestamp: 1 }] as unknown as AgentMessage[];
        await new FileConversationStore(dir).save("+39333", messages);

        expect(await new FileConversationStore(dir).load("+39333")).toEqual(messages);
        expect(await new FileConversationStore(dir).load("+39444")).toEqual([]);
        expect(readdirSync(dir).join()).not.toContain("39333");
    });
});
