import type { Message, Space } from "@spectrum-ts/core";
import { describe, expect, it } from "vitest";
import { ChatBook } from "../src/channels/chats.js";
import { PhotonChannel, templateParam, userIdOf } from "../src/channels/photon.js";

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

    it("knows a WhatsApp number written as bare digits is the same person", async () => {
        const orchestrator = echo();
        const channel = new PhotonChannel(orchestrator, new Set(["+39 333 123 4567"]));
        const { space, sent } = fakeSpace("393331234567");

        await channel.handle(space, inbound("m1", "393331234567", "ciao", "whatsapp_business"));

        expect(orchestrator.calls).toEqual([["+393331234567", "ciao"]]);
        expect(sent).toEqual(["you said: ciao"]);
    });

    it("lets the agent react to the message, and sends nothing when the reaction is the answer", async () => {
        const reactions: string[] = [];
        const message = {
            ...inbound("m1", "+39333", "thanks!", "whatsapp_business"),
            react: async (emoji: string) => {
                reactions.push(emoji);
                return { id: "r1" };
            },
        } as unknown as Message;
        const orchestrator = {
            send: async (_userId: string, _text: string, options: { react: (emoji: string) => Promise<boolean> }) => {
                expect(await options.react("❤️")).toBe(true);
                return "";
            },
        };
        const channel = new PhotonChannel(orchestrator, new Set(["+39333"]));
        const { space, sent } = fakeSpace("chat-1");

        await channel.handle(space, message);

        expect(reactions).toEqual(["❤️"]);
        expect(sent).toEqual([]);
    });

    it("matches an Apple ID whatever its case", () => {
        expect(userIdOf(" Luis@iCloud.com ")).toBe("luis@icloud.com");
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

describe("PhotonChannel speaking first", () => {
    const hour = 3_600_000;

    it("finds the chat again after a restart", async () => {
        const chats = new ChatBook();
        const before = new PhotonChannel(echo(), new Set(["+39333"]), { chats });
        await before.handle(fakeSpace("chat-1").space, inbound("m1", "+39333", "hi", "imessage"));

        const reopened = fakeSpace("chat-1");
        const opened: string[] = [];
        const after = new PhotonChannel(echo(), new Set(["+39333"]), {
            chats,
            openSpace: async (platform, spaceId) => {
                opened.push(`${platform}/${spaceId}`);
                return reopened.space;
            },
        });
        await after.notify("+39333", "Time to call mum 📞");
        expect(opened).toEqual(["imessage/chat-1"]);
        expect(reopened.sent).toEqual(["Time to call mum 📞"]);
    });

    it("wraps a WhatsApp message in the template once the 24-hour window has closed", async () => {
        let now = new Date("2026-10-22T09:00:00Z");
        const channel = new PhotonChannel(echo(), new Set(["+39333"]), {
            template: { name: "conscious_message", languageCode: "en" },
            now: () => now,
        });
        const { space, sent } = fakeSpace("39333");
        await channel.handle(space, inbound("m1", "39333", "hi", "whatsapp_business"));

        now = new Date(now.getTime() + 2 * hour);
        await channel.notify("+39333", "Inside the window");
        now = new Date(now.getTime() + 30 * hour);
        await channel.notify("+39333", "Line one\nline two");

        expect(sent[1]).toBe("Inside the window");
        expect(await (sent[2] as unknown as { build(): Promise<unknown> }).build()).toMatchObject({
            type: "whatsapp-template",
            name: "conscious_message",
            bodyParams: ["Line one · line two"],
        });
    });

    it("keeps template text inside WhatsApp's rules", () => {
        expect(templateParam("a\n\n  b\tc     d")).toBe("a · b c d");
        expect(templateParam("x".repeat(2000))).toHaveLength(900);
    });
});
