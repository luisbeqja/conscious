import { describe, expect, it, vi } from "vitest";
import { ChatBook } from "../src/channels/chats.js";
import {
    createTelegramApi,
    pieces,
    type TelegramApi,
    TelegramChannel,
    TelegramError,
    type TelegramMessage,
    telegramHtml,
} from "../src/channels/telegram.js";
import { inviteCommands } from "../src/invites/commands.js";
import { Invites } from "../src/invites/invites.js";
import type { IncomingFile, OutgoingFile } from "../src/media/incoming.js";

type Handler = (params: Record<string, unknown>) => unknown;

/** A Bot API that records every call. Methods without a handler answer `true`, as most do. */
const fakeApi = (handlers: Record<string, Handler> = {}) => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const api: TelegramApi = {
        call: async <T>(method: string, params: Record<string, unknown> = {}) => {
            calls.push({ method, params });
            return ((await handlers[method]?.(params)) ?? true) as T;
        },
        download: async (fileId) => new TextEncoder().encode(`bytes of ${fileId}`),
    };
    const of = (method: string) => calls.filter((call) => call.method === method).map((call) => call.params);
    return { api, calls, of, sent: () => of("sendMessage").map((params) => params.text) };
};

const message = (text: string | undefined, extra: Partial<TelegramMessage> = {}): TelegramMessage => ({
    message_id: 7,
    from: { id: 111, username: "luis" },
    chat: { id: 111, type: "private" },
    text,
    ...extra,
});

type Options = {
    say: (text: string) => Promise<void>;
    react: (emoji: string) => Promise<boolean>;
    files?: IncomingFile[];
    sendFile?: (file: OutgoingFile) => Promise<void>;
};

const echo = () => {
    const calls: [string, string, IncomingFile[] | undefined][] = [];
    return {
        calls,
        send: async (userId: string, text: string, options: Options) => {
            calls.push([userId, text, options.files]);
            await options.say(`you said: ${text}`);
        },
    };
};

const users = new Map([["111", "+39333"]]);

describe("TelegramChannel", () => {
    it("answers a listed user in their private chat, with the typing indicator", async () => {
        const { api, of, sent } = fakeApi();
        const orchestrator = echo();

        await new TelegramChannel(api, orchestrator, users).handle(message("hi"));

        expect(orchestrator.calls).toEqual([["+39333", "hi", []]]);
        expect(sent()).toEqual(["you said: hi"]);
        expect(of("sendMessage")[0]).toMatchObject({ chat_id: "111", parse_mode: "HTML" });
        expect(of("sendChatAction")).toEqual([{ chat_id: "111", action: "typing" }]);
    });

    it("knows a number listed with spaces is the same person as on WhatsApp", async () => {
        const orchestrator = echo();
        const listed = new Map([["111", "+39 333 123 4567"]]);
        await new TelegramChannel(fakeApi().api, orchestrator, listed).handle(message("ciao"));
        expect(orchestrator.calls[0]?.[0]).toBe("+393331234567");
    });

    it("logs the id of someone not on the list, and stays out of groups", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { api, calls } = fakeApi();
        const orchestrator = echo();
        const channel = new TelegramChannel(api, orchestrator, users);

        await channel.handle(
            message("hi", { from: { id: 222, username: "stranger" }, chat: { id: 222, type: "private" } }),
        );
        await channel.handle(message("hi all", { chat: { id: -100, type: "group" } }));

        expect(orchestrator.calls).toEqual([]);
        expect(calls).toEqual([]);
        expect(warn.mock.calls[0]?.[0]).toContain("222 (@stranger)");
        warn.mockRestore();
    });

    it("hears /start, sent when someone opens the bot, as a hello", async () => {
        const orchestrator = echo();
        await new TelegramChannel(fakeApi().api, orchestrator, users).handle(message("/start"));
        expect(orchestrator.calls[0]?.[1]).toBe("Hi!");
    });

    it("writes out a voice note and hands the agent the text", async () => {
        const heard: string[] = [];
        const orchestrator = echo();
        const channel = new TelegramChannel(fakeApi().api, orchestrator, users, {
            transcriber: {
                name: "fake",
                transcribe: async (audio, mimeType) => {
                    heard.push(`${new TextDecoder().decode(audio)} (${mimeType})`);
                    return "remind me to buy milk";
                },
            },
        });

        await channel.handle(message(undefined, { voice: { file_id: "v1", mime_type: "audio/ogg" } }));

        expect(heard).toEqual(["bytes of v1 (audio/ogg)"]);
        expect(orchestrator.calls[0]?.[1]).toBe("(voice note) remind me to buy milk");
    });

    it("passes the largest size of a photo with its caption, and refuses a file over 20 MB", async () => {
        const { api, sent } = fakeApi();
        const orchestrator = echo();
        const channel = new TelegramChannel(api, orchestrator, users);

        await channel.handle(
            message(undefined, { caption: "is this ripe?", photo: [{ file_id: "small" }, { file_id: "large" }] }),
        );
        await channel.handle(message(undefined, { document: { file_id: "d1", file_size: 30_000_000 } }));

        const [, text, files] = orchestrator.calls[0] ?? [];
        expect(text).toBe("is this ripe?");
        expect(files?.map((file) => [file.name, file.mimeType, new TextDecoder().decode(file.data)])).toEqual([
            ["photo.jpg", "image/jpeg", "bytes of large"],
        ]);
        expect(orchestrator.calls).toHaveLength(1);
        expect(sent().at(-1)).toMatch(/too big/);
    });

    it("sends the words without formatting when Telegram cannot read it", async () => {
        const { api, sent } = fakeApi({
            sendMessage: (params) => {
                if (params.parse_mode) throw new TelegramError("sendMessage", 400, "Bad Request: can't parse entities");
            },
        });

        await new TelegramChannel(api, echo(), users).handle(message("hi"));

        expect(sent()).toEqual(["you said: hi", "you said: hi"]);
    });

    it("reacts with Telegram's form of the emoji, and says so when the reaction is refused", async () => {
        let refuse = false;
        const { api, of } = fakeApi({
            setMessageReaction: () => {
                if (refuse) throw new TelegramError("setMessageReaction", 400, "Bad Request: REACTION_INVALID");
            },
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const results: boolean[] = [];
        const orchestrator = {
            send: async (_userId: string, _text: string, options: Options) => {
                results.push(await options.react("❤️"));
                refuse = true;
                results.push(await options.react("😂"));
            },
        };

        await new TelegramChannel(api, orchestrator, users).handle(message("thanks!"));

        expect(results).toEqual([true, false]);
        expect(of("setMessageReaction")[0]).toEqual({
            chat_id: "111",
            message_id: 7,
            reaction: [{ type: "emoji", emoji: "❤" }],
        });
        warn.mockRestore();
    });

    it("sends a photo as a photo and any other file as a document", async () => {
        const { api, calls } = fakeApi();
        const orchestrator = {
            send: async (_userId: string, _text: string, options: Options) => {
                await options.sendFile?.({ name: "map.png", mimeType: "image/png", data: new Uint8Array([1]) });
                await options.sendFile?.({ name: "plan.pdf", mimeType: "application/pdf", data: new Uint8Array([2]) });
            },
        };

        await new TelegramChannel(api, orchestrator, users).handle(message("send me the plan"));

        const uploads = calls.filter((call) => call.method !== "sendChatAction");
        expect(
            uploads.map((call) => [call.method, ((call.params.photo ?? call.params.document) as File).name]),
        ).toEqual([
            ["sendPhoto", "map.png"],
            ["sendDocument", "plan.pdf"],
        ]);
    });

    it("speaks first in the user's chat with the bot, found again after a restart", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const chats = new ChatBook();
        await new TelegramChannel(fakeApi().api, echo(), users, { chats }).handle(message("hi"));
        const { api, of } = fakeApi();
        const after = new TelegramChannel(api, echo(), users, { chats });

        await after.notify("+39333", "Time to call mum 📞");
        await after.notify("+39444", "nobody to send this to");

        expect(of("sendMessage")).toEqual([{ chat_id: "111", text: "Time to call mum 📞", parse_mode: "HTML" }]);
        warn.mockRestore();
    });

    it("asks for each message once, keeps asking after a conflict, and stops on abort", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const stop = new AbortController();
        const replies: (() => unknown)[] = [
            () => [{ update_id: 5, message: message("hi") }],
            () => {
                throw new TelegramError("getUpdates", 409, "Conflict: terminated by other getUpdates request");
            },
            () => {
                stop.abort();
                return [];
            },
        ];
        const { api, calls, sent } = fakeApi({
            getMe: () => ({ username: "conscious_bot" }),
            getUpdates: () => replies.shift()?.(),
        });

        await new TelegramChannel(api, echo(), users, { pause: async () => {} }).listen(stop.signal);

        expect(calls.slice(0, 2).map((call) => call.method)).toEqual(["getMe", "deleteWebhook"]);
        expect(calls.filter((call) => call.method === "getUpdates").map((call) => call.params.offset)).toEqual([
            undefined,
            6,
            6,
        ]);
        await vi.waitFor(() => expect(sent()).toEqual(["you said: hi"]));
        warn.mockRestore();
        log.mockRestore();
    });

    it("stops when Telegram refuses the token", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const { api, calls } = fakeApi({
            getMe: () => {
                throw new TelegramError("getMe", 401, "Unauthorized");
            },
        });

        await new TelegramChannel(api, echo(), users).listen(new AbortController().signal);

        expect(calls.map((call) => call.method)).toEqual(["getMe"]);
        error.mockRestore();
    });
});

describe("TelegramChannel invites", () => {
    const friend = (text: string | undefined, extra: Partial<TelegramMessage> = {}) =>
        message(text, { from: { id: 222, username: "marco" }, chat: { id: 222, type: "private" }, ...extra });
    const shared = (phone: string, userId = 222) =>
        friend(undefined, { contact: { phone_number: phone, user_id: userId } });

    const setup = () => {
        const invites = new Invites();
        const { code } = invites.create("+39444", "+39333");
        const { api, of, sent } = fakeApi();
        const orchestrator = echo();
        const joined: string[] = [];
        const channel = new TelegramChannel(api, orchestrator, users, {
            invites,
            onJoined: (guest) => joined.push(`${guest.userId} by ${guest.invitedBy}`),
        });
        return { invites, code, api, of, sent, orchestrator, joined, channel };
    };

    it("lets a friend in once they share the number the invite was made for, then says hello", async () => {
        const { code, of, sent, orchestrator, joined, channel } = setup();

        await channel.handle(friend(`/start ${code}`));
        expect(of("sendMessage")[0]?.reply_markup).toMatchObject({
            keyboard: [[{ request_contact: true }]],
        });
        await channel.handle(shared("39444"));
        await channel.handle(friend("what can you do?"));

        expect(sent()).toEqual([
            expect.stringContaining("You've been invited to Conscious"),
            "You're in ✅",
            "you said: Hi!",
            "you said: what can you do?",
        ]);
        expect(of("sendMessage")[1]?.reply_markup).toEqual({ remove_keyboard: true });
        expect(orchestrator.calls.map(([userId, text]) => [userId, text])).toEqual([
            ["+39444", "Hi!"],
            ["+39444", "what can you do?"],
        ]);
        expect(joined).toEqual(["+39444 by +39333"]);
    });

    it("refuses another number, a contact passed on from someone else, and a spent link", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { invites, code, sent, orchestrator, channel } = setup();

        await channel.handle(friend(`/start ${code}`));
        await channel.handle(shared("39555"));
        await channel.handle(shared("39444", 999));
        await channel.handle(friend("hello?"));
        await channel.handle(friend("/start inv-notacode"));

        expect(sent().slice(1)).toEqual([
            "That isn't the number this invite was made for. Ask for an invite for your own number.",
            "That isn't the number this invite was made for. Ask for an invite for your own number.",
            "This invite link has expired or was already used. Ask for a new one.",
        ]);
        expect(orchestrator.calls).toEqual([]);
        expect(invites.telegramUser("222")).toBeUndefined();
        warn.mockRestore();
    });

    it("answers the owner's /invite with a link to this bot, without the agent", async () => {
        const invites = new Invites();
        const { api, calls, sent } = fakeApi({
            getMe: () => ({ username: "conscious_bot" }),
            getUpdates: () => {
                stop.abort();
                return [];
            },
        });
        const stop = new AbortController();
        const orchestrator = echo();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const channel: TelegramChannel = new TelegramChannel(api, orchestrator, users, {
            invites,
            command: inviteCommands({
                invites,
                isOwner: (userId) => userId === "+39333",
                telegramLink: (code) => channel.link(code),
            }),
        });
        await channel.listen(stop.signal);

        await channel.handle(message("/invite +39 444 123 4567"));

        expect(sent()).toContainEqual(
            expect.stringMatching(/^https:\/\/t\.me\/conscious_bot\?start=inv-[a-z2-9]{10}$/),
        );
        expect(orchestrator.calls).toEqual([]);
        expect(calls.some((call) => call.method === "sendChatAction")).toBe(false);
        log.mockRestore();
    });
});

describe("Telegram formatting", () => {
    it("shows *bold* as bold and escapes everything else", () => {
        expect(telegramHtml("*Tuesday* is free & <fun>")).toBe("<b>Tuesday</b> is free &amp; &lt;fun&gt;");
        expect(telegramHtml("I'm **so** happy!")).toBe("I'm <b>so</b> happy!");
        expect(telegramHtml("5 * 3 * 2, a*b*c\n* not a list")).toBe("5 * 3 * 2, a*b*c\n* not a list");
    });

    it("cuts a message past 4,096 characters at a line break", () => {
        const paragraph = `${"word ".repeat(600).trim()}\n`;
        const parts = pieces(paragraph.repeat(3).trim());
        expect(parts.length).toBeGreaterThan(1);
        expect(parts.every((part) => part.length <= 4096)).toBe(true);
        expect(parts.join("\n")).toBe(paragraph.repeat(3).trim());
    });
});

describe("createTelegramApi", () => {
    it("sends JSON, uploads files as a form, and keeps the token out of errors", async () => {
        const requests: { url: string; body: unknown }[] = [];
        const doFetch = (async (url: string, init?: RequestInit) => {
            requests.push({ url, body: init?.body });
            if (url.endsWith("/sendMessage")) {
                return Response.json(
                    { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
                    { status: 403 },
                );
            }
            if (url.endsWith("/getFile")) return Response.json({ ok: true, result: { file_path: "voice/file_1.oga" } });
            if (url.includes("/file/")) return new Response("ogg");
            return Response.json({ ok: true, result: true });
        }) as typeof fetch;
        const api = createTelegramApi("123:secret", doFetch);

        await api.call("sendDocument", { chat_id: "111", document: new File(["pdf"], "plan.pdf") });
        const failure = await api.call("sendMessage", { chat_id: "111", text: "hi" }).catch((error: unknown) => error);
        const audio = await api.download("abc");

        expect(requests[0]?.url).toBe("https://api.telegram.org/bot123:secret/sendDocument");
        expect(((requests[0]?.body as FormData).get("document") as File).name).toBe("plan.pdf");
        expect(requests[1]?.body).toBe(JSON.stringify({ chat_id: "111", text: "hi" }));
        expect(failure).toBeInstanceOf(TelegramError);
        expect((failure as TelegramError).code).toBe(403);
        expect((failure as Error).message).not.toContain("secret");
        expect(requests.at(-1)?.url).toBe("https://api.telegram.org/file/bot123:secret/voice/file_1.oga");
        expect(new TextDecoder().decode(audio)).toBe("ogg");
    });
});
