import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { splitMessage } from "../src/channels/whatsapp/client.js";
import { parseInbound, verifySignature } from "../src/channels/whatsapp/webhook.js";

describe("WhatsApp webhook", () => {
    it("reads text messages and skips everything else", () => {
        const messages = parseInbound({
            entry: [
                {
                    changes: [
                        {
                            value: {
                                messages: [
                                    {
                                        from: "393331234567",
                                        id: "m1",
                                        timestamp: "1760270400",
                                        type: "text",
                                        text: { body: "hi" },
                                    },
                                    { from: "393331234567", id: "m2", timestamp: "1760270400", type: "image" },
                                ],
                            },
                        },
                    ],
                },
            ],
        });
        expect(messages).toEqual([
            { userId: "393331234567", messageId: "m1", text: "hi", receivedAt: new Date(1760270400 * 1000) },
        ]);
    });

    it("accepts only Meta's signature", () => {
        const body = '{"entry":[]}';
        const good = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
        expect(verifySignature(body, good, "secret")).toBe(true);
        expect(verifySignature(body, good, "other")).toBe(false);
        expect(verifySignature(body, undefined, "secret")).toBe(false);
    });

    it("splits a long reply on line breaks under WhatsApp's limit", () => {
        const parts = splitMessage(`${"a".repeat(30)}\n${"b".repeat(30)}`, 40);
        expect(parts).toEqual(["a".repeat(30), "b".repeat(30)]);
    });
});
