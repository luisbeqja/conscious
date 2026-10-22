import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SandboxProvider } from "../sandbox/sandbox.js";
import { type ConversationStore, MAX_MESSAGES, trim } from "./store.js";

const CONVERSATION_FILE = ".conscious/conversation.json";

/** The conversation lives in the user's sandbox with the rest of what Conscious knows, so it survives restarts. */
export class SandboxConversationStore implements ConversationStore {
    constructor(private readonly sandboxes: SandboxProvider) {}

    async load(userId: string): Promise<AgentMessage[]> {
        const sandbox = await this.sandboxes.forUser(userId);
        const saved = await sandbox.readFile(CONVERSATION_FILE);
        return saved ? (JSON.parse(saved) as AgentMessage[]) : [];
    }

    async save(userId: string, messages: AgentMessage[]): Promise<void> {
        const sandbox = await this.sandboxes.forUser(userId);
        await sandbox.writeFile(CONVERSATION_FILE, JSON.stringify(trim(messages, MAX_MESSAGES)));
    }
}
