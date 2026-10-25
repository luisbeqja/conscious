import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { asSaid, withSentReplies } from "../src/conversations/store.js";
import { renderRecentChat } from "../src/prompts/prompts.js";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (content: unknown[], stopReason = "stop") => ({
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude",
    usage: {},
    stopReason,
    timestamp: 2,
});
const text = (value: string) => ({ type: "text", text: value });
const call = (name: string, args: Record<string, unknown>, id = "t1") => ({
    type: "toolCall",
    id,
    name,
    arguments: args,
});
const result = (name: string, id = "t1") => ({
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [text("{}")],
    isError: false,
    timestamp: 3,
});
const messages = (...list: unknown[]) => list as AgentMessage[];

describe("the transcript", () => {
    it("shows a reply from before the message tool as a message it sent", () => {
        const before = messages(
            user("hi"),
            assistant([{ type: "thinking", thinking: "say hi" }, text("Hey Lu!")]),
            user("weather?"),
            assistant([text("Let me look"), call("web_search_pages", { query: "Milan" })], "toolUse"),
            result("web_search_pages"),
            assistant([text("Grey, 9°C.")]),
        );
        const after = withSentReplies(before);

        expect(after).toHaveLength(8);
        expect(after[1]).toMatchObject({
            stopReason: "toolUse",
            content: [
                { type: "thinking" },
                { type: "toolCall", name: "chat_send_message", arguments: { text: "Hey Lu!" } },
            ],
        });
        expect(after[2]).toMatchObject({ role: "toolResult", toolName: "chat_send_message", isError: false });
        // A text written before a tool call was never the reply, so it stays as it was.
        expect(after[4]).toBe(before[3]);
        expect(after[6]).toMatchObject({ content: [{ type: "toolCall", arguments: { text: "Grey, 9°C." } }] });
        expect(renderRecentChat(after, "thanks")).toBe(
            "User: hi\nYou: Hey Lu!\nUser: weather?\nYou: Grey, 9°C.\nUser: thanks",
        );
    });

    it("leaves answers saved with the tool as they are, and still shows a later plain reply as sent", () => {
        const saved = messages(
            user("hi"),
            assistant([call("chat_send_message", { text: "Hey!" })], "toolUse"),
            result("chat_send_message"),
            user("thanks"),
            assistant([call("reactions_react_message", { emoji: "❤️" }, "t2")], "toolUse"),
            result("reactions_react_message", "t2"),
        );
        expect(withSentReplies(saved)).toEqual(saved);
        expect(renderRecentChat(saved, "bye")).toBe("User: hi\nYou: Hey!\nUser: thanks\nUser: bye");

        // An older version, back for a while, answered in text after the first message sent with the tool.
        const mixed = withSentReplies([...saved, ...messages(user("bye"), assistant([text("Ciao!")]))]);
        expect(mixed.at(-2)).toMatchObject({ content: [{ type: "toolCall", arguments: { text: "Ciao!" } }] });
    });

    it("keeps of an answer what was said and done, not text nobody saw or the reminder to send", () => {
        const answer = messages(
            user("is Thursday ok?"),
            assistant([text("Thursday works.")]),
            { role: "user", content: "<context>\nNot delivered…\n</context>", timestamp: 4 },
            assistant(
                [
                    { type: "thinking", thinking: "send it" },
                    text("Sending."),
                    call("chat_send_message", { text: "Thursday works 🦷" }),
                ],
                "toolUse",
            ),
            result("chat_send_message"),
            assistant([text("Done.")]),
        );
        expect(asSaid(answer)).toEqual([
            answer[0],
            {
                ...(answer[3] as object),
                content: [
                    { type: "thinking", thinking: "send it" },
                    call("chat_send_message", { text: "Thursday works 🦷" }),
                ],
            },
            answer[4],
        ]);
    });
});
