import type { Message, Space } from "@spectrum-ts/core";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/** What a channel hands the orchestrator with each message. */
type Say = { say: (text: string) => Promise<void> };

const echo = () => {
    const calls: [string, string][] = [];
    return {
        calls,
        send: async (userId: string, text: string, options: Say) => {
            calls.push([userId, text]);
            await options.say(`you said: ${text}`);
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

    it("sends each message the moment the agent sends it, before the answer is done", async () => {
        let finish: () => void = () => {};
        const finished = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const orchestrator = {
            send: async (_userId: string, _text: string, options: Say) => {
                await options.say("On it 👀");
                await finished;
                await options.say("Tuesday is free all afternoon.");
            },
        };
        const channel = new PhotonChannel(orchestrator, new Set(["+39333"]));
        const { space, sent } = fakeSpace("chat-1");

        const handled = channel.handle(space, inbound("m1", "+39333", "am I free on tuesday?"));
        await vi.waitFor(() => expect(sent).toEqual(["On it 👀"]));
        finish();
        await handled;
        expect(sent).toEqual(["On it 👀", "Tuesday is free all afternoon."]);
    });

    describe("WhatsApp typing", () => {
        afterEach(() => vi.useRealTimers());

        it("shows typing on WhatsApp while the answer is written, again every 20 seconds, then stops", async () => {
            vi.useFakeTimers();
            const shown: string[] = [];
            let finish: (reply: string) => Promise<void> = async () => {};
            const orchestrator = {
                send: (_userId: string, _text: string, options: Say) =>
                    new Promise<void>((resolve) => {
                        finish = async (reply) => {
                            await options.say(reply);
                            resolve();
                        };
                    }),
            };
            const channel = new PhotonChannel(orchestrator, new Set(["+39333"]), {
                showWhatsAppTyping: async (id) => {
                    shown.push(id);
                },
            });
            const { space, sent } = fakeSpace("39333");

            const handled = channel.handle(space, inbound("wamid.1", "39333", "plan my weekend", "whatsapp_business"));
            await vi.advanceTimersByTimeAsync(45_000);
            expect(shown).toEqual(["wamid.1", "wamid.1", "wamid.1"]);

            await finish("Here's a plan.");
            await handled;
            await vi.advanceTimersByTimeAsync(60_000);
            expect(shown).toHaveLength(3);
            expect(sent).toEqual(["Here's a plan."]);
        });

        it("still answers when typing fails, and leaves iMessage to Spectrum", async () => {
            const shown: string[] = [];
            const channel = new PhotonChannel(echo(), new Set(["+39333"]), {
                showWhatsAppTyping: async (id) => {
                    shown.push(id);
                    throw new Error("line is down");
                },
            });
            const { space, sent } = fakeSpace("39333");

            await channel.handle(space, inbound("wamid.2", "39333", "hi", "whatsapp_business"));
            await channel.handle(space, inbound("m3", "+39333", "hi again"));

            expect(shown).toEqual(["wamid.2"]);
            expect(sent).toEqual(["you said: hi", "you said: hi again"]);
        });
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

    it("writes out a voice note and hands the agent the text", async () => {
        const orchestrator = echo();
        const heard: string[] = [];
        const channel = new PhotonChannel(orchestrator, new Set(["+39333"]), {
            transcriber: {
                name: "fake",
                transcribe: async (_audio, mimeType) => {
                    heard.push(mimeType);
                    return "remind me to buy milk";
                },
            },
        });
        const { space, sent } = fakeSpace("chat-1");
        await channel.handle(space, {
            ...inbound("m1", "+39333", ""),
            content: { type: "voice", mimeType: "audio/ogg; codecs=opus", read: async () => Buffer.from("ogg") },
        } as unknown as Message);

        expect(heard).toEqual(["audio/ogg; codecs=opus"]);
        expect(orchestrator.calls).toEqual([["+39333", "(voice note) remind me to buy milk"]]);
        expect(sent).toEqual(["you said: (voice note) remind me to buy milk"]);
    });

    it("says so when it cannot listen, without bothering the agent", async () => {
        const orchestrator = echo();
        const channel = new PhotonChannel(orchestrator, new Set(["+39333"]));
        const { space, sent } = fakeSpace("chat-1");
        await channel.handle(space, {
            ...inbound("m1", "+39333", ""),
            content: { type: "voice", mimeType: "audio/ogg", read: async () => Buffer.from("") },
        } as unknown as Message);

        expect(orchestrator.calls).toEqual([]);
        expect(sent[0]).toMatch(/voice notes/);
    });

    it("passes files to the agent and lets it send files back", async () => {
        const got: { files?: { name: string; data: Uint8Array }[] }[] = [];
        const orchestrator = {
            send: async (
                _userId: string,
                _text: string,
                options: Say & {
                    files?: { name: string; mimeType: string; data: Uint8Array }[];
                    sendFile?: (file: { name: string; mimeType: string; data: Uint8Array }) => Promise<void>;
                },
            ) => {
                got.push(options);
                await options.sendFile?.({ name: "plan.pdf", mimeType: "application/pdf", data: new Uint8Array([1]) });
                await options.say("Here's your plan.");
            },
        };
        const channel = new PhotonChannel(orchestrator as never, new Set(["+39333"]));
        const { space, sent } = fakeSpace("chat-1");
        await channel.handle(space, {
            ...inbound("m1", "+39333", ""),
            content: {
                type: "attachment",
                name: "ticket.pdf",
                mimeType: "application/pdf",
                size: 3,
                read: async () => Buffer.from("pdf"),
            },
        } as unknown as Message);

        expect(got[0]?.files?.map((file) => file.name)).toEqual(["ticket.pdf"]);
        expect(sent).toHaveLength(2);
        expect(sent[1]).toBe("Here's your plan.");
    });

    it("ignores reactions instead of answering them", async () => {
        const orchestrator = echo();
        const channel = new PhotonChannel(orchestrator, new Set(["+39333"]));
        const { space, sent } = fakeSpace("chat-1");
        await channel.handle(space, {
            ...inbound("m1", "+39333", ""),
            content: { type: "reaction" },
        } as unknown as Message);
        expect(orchestrator.calls).toEqual([]);
        expect(sent).toEqual([]);
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
