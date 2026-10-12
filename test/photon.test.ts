import type { Message, Space } from "@spectrum-ts/core";
import { describe, expect, it } from "vitest";
import { PhotonChannel } from "../src/channels/photon.js";

const fakeSpace = (id: string) => {
    const sent: string[] = [];
    let responding = 0;
    const space = {
        id,
        send: async (content: string) => {
            sent.push(content);
        },
        responding: async <T>(fn: () => Promise<T>) => {
            responding += 1;
            return fn();
        },
    };
    return { space: space as unknown as Space, sent, respondingCalls: () => responding };
};

const inbound = (id: string, sender: string, text: string, platform = "iMessage") =>
    ({
        id,
        platform,
        direction: "inbound",
        sender: { id: sender },
        content: { type: "text", text },
    }) as unknown as Message;

const echo = () => {
    const calls: [string, string][] = [];
    return {
        calls,
        send: async (userId: string, text: string) => {
            calls.push([userId, text]);
            return `you said: ${text}`;
        },
    };
};

describe("PhotonChannel", () => {
    it("answers an allowed sender in the chat they wrote from, with the typing indicator", async () => {
        const orchestrator = echo();
        const channel = new PhotonChannel(orchestrator, new Set(["+39333"]));
        const { space, sent, respondingCalls } = fakeSpace("chat-1");

        await channel.handle(space, inbound("m1", "+39333", "hi"));

        expect(orchestrator.calls).toEqual([["+39333", "hi"]]);
        expect(sent).toEqual(["you said: hi"]);
        expect(respondingCalls()).toBe(1);
    });

    it("ignores senders not on the list and its own outbound messages", async () => {
        const orchestrator = echo();
        const channel = new PhotonChannel(orchestrator, new Set(["+39333"]));
        const { space, sent } = fakeSpace("chat-1");

        await channel.handle(space, inbound("m1", "+1555", "hi"));
        await channel.handle(space, { ...inbound("m2", "+39333", "hi"), direction: "outbound" } as Message);

        expect(orchestrator.calls).toEqual([]);
        expect(sent).toEqual([]);
    });

    it("answers a redelivered message once", async () => {
        const orchestrator = echo();
        const channel = new PhotonChannel(orchestrator, new Set(["+39333"]));
        const { space } = fakeSpace("chat-1");

        await channel.handle(space, inbound("m1", "+39333", "hi"));
        await channel.handle(space, inbound("m1", "+39333", "hi"));

        expect(orchestrator.calls).toHaveLength(1);
    });

    it("sends notifications to the chat the user last wrote from", async () => {
        const channel = new PhotonChannel(echo(), new Set(["+39333"]));
        const imessageChat = fakeSpace("imessage-chat");
        const whatsappChat = fakeSpace("whatsapp-chat");

        await channel.notify("+39333", "nobody to send this to yet");
        await channel.handle(imessageChat.space, inbound("m1", "+39333", "hi"));
        await channel.handle(whatsappChat.space, inbound("m2", "+39333", "hi again", "WhatsApp"));
        await channel.notify("+39333", "Call mum 📞");

        expect(whatsappChat.sent.at(-1)).toBe("Call mum 📞");
        expect(imessageChat.sent).not.toContain("Call mum 📞");
    });

    it("tells the user it can only read text", async () => {
        const orchestrator = echo();
        const channel = new PhotonChannel(orchestrator, new Set(["+39333"]));
        const { space, sent } = fakeSpace("chat-1");

        await channel.handle(space, {
            ...inbound("m1", "+39333", ""),
            content: { type: "attachment" },
        } as unknown as Message);

        expect(orchestrator.calls).toEqual([]);
        expect(sent).toEqual(["I can only read text for now."]);
    });
});
