import type { Message, Space } from "@spectrum-ts/core";
import { describe, expect, it } from "vitest";
import { bubbles } from "../src/channels/bubbles.js";
import { PhotonChannel } from "../src/channels/photon.js";

describe("bubbles", () => {
    it("sends short paragraphs as separate messages, and keeps lists and long text whole", () => {
        expect(bubbles("Ohh that's the one you wanted!\n\nWhat time? I'll ask how it went after")).toEqual([
            "Ohh that's the one you wanted!",
            "What time? I'll ask how it went after",
        ]);
        expect(bubbles("done, Thursday 9:00 📞")).toEqual(["done, Thursday 9:00 📞"]);
        const list = "Three ideas:\n\n- a plant\n- a book";
        expect(bubbles(list)).toEqual([list]);
        const long = `Short.\n\n${"word ".repeat(100)}`;
        expect(bubbles(long)).toEqual([long]);
        const many = "a\n\nb\n\nc\n\nd\n\ne";
        expect(bubbles(many)).toEqual([many]);
    });

    it("sends a chatty reply as bubbles, with a pause between them", async () => {
        const sent: string[] = [];
        const pauses: number[] = [];
        const space = {
            id: "chat-1",
            send: async (content: string) => {
                sent.push(content);
            },
            responding: async <T>(fn: () => Promise<T>) => fn(),
        } as unknown as Space;
        const channel = new PhotonChannel({ send: async () => "Ohh nice!\n\nHow did it go?" }, new Set(["+39333"]), {
            pause: async (ms) => void pauses.push(ms),
        });
        const message = {
            id: "m1",
            platform: "iMessage",
            direction: "inbound",
            sender: { id: "+39333" },
            content: { type: "text", text: "I got the job" },
        } as unknown as Message;

        await channel.handle(space, message);
        expect(sent).toEqual(["Ohh nice!", "How did it go?"]);
        expect(pauses).toHaveLength(1);
    });
});
