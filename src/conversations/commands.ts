import type { Command } from "../invites/commands.js";

/** What /new needs from the orchestrator. */
export interface Conversations {
    newConversation(userId: string): Promise<void>;
}

const NEW = new Set(["/new", "/nuova"]);

/**
 * /new starts a new conversation: what was said so far is set aside, so the next message comes
 * with a clean context. Memory, reminders and agents stay. It skips the agent, which would
 * otherwise read the command with the whole old conversation.
 */
export const conversationCommands =
    (conversations: Conversations): Command =>
    (userId, text) => {
        // In a group Telegram writes /new@bot_name; the name is not needed here.
        const command = (text.trim().split(/\s+/)[0] ?? "").split("@")[0]?.toLowerCase() ?? "";
        if (!NEW.has(command)) return undefined;
        conversations.newConversation(userId).catch((error: unknown) => {
            console.error(`[conversations] could not start a new one for ${userId}`, error);
        });
        return "New conversation ✨ What we said before is set aside. I still remember what I know about you.";
    };
