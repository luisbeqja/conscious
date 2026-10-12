import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { WhatsAppConfig } from "../../config.js";
import type { InboundMessage } from "../channel.js";

interface WebhookPayload {
    entry?: {
        changes?: {
            value?: {
                messages?: { from: string; id: string; timestamp: string; type: string; text?: { body: string } }[];
            };
        }[];
    }[];
}

/** Text messages only for now; voice notes and pictures are the next thing to read. */
export const parseInbound = (payload: WebhookPayload): InboundMessage[] =>
    (payload.entry ?? []).flatMap((entry) =>
        (entry.changes ?? []).flatMap((change) =>
            (change.value?.messages ?? []).flatMap((message) =>
                message.type === "text" && message.text?.body
                    ? [
                          {
                              userId: message.from,
                              messageId: message.id,
                              text: message.text.body,
                              receivedAt: new Date(Number(message.timestamp) * 1000),
                          },
                      ]
                    : [],
            ),
        ),
    );

export const verifySignature = (rawBody: string, header: string | undefined, appSecret: string): boolean => {
    if (!header?.startsWith("sha256=")) return false;
    const expected = createHmac("sha256", appSecret).update(rawBody).digest();
    const given = Buffer.from(header.slice("sha256=".length), "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
};

export const whatsappWebhook = (config: WhatsAppConfig, onMessage: (message: InboundMessage) => void) => {
    const app = new Hono();

    app.get("/", (c) => {
        const ok = c.req.query("hub.mode") === "subscribe" && c.req.query("hub.verify_token") === config.verifyToken;
        return ok ? c.text(c.req.query("hub.challenge") ?? "") : c.text("forbidden", 403);
    });

    app.post("/", async (c) => {
        const raw = await c.req.text();
        if (!verifySignature(raw, c.req.header("x-hub-signature-256"), config.appSecret)) {
            return c.text("bad signature", 401);
        }
        // Meta retries anything not answered quickly, so the work happens after the 200.
        for (const message of parseInbound(JSON.parse(raw) as WebhookPayload)) onMessage(message);
        return c.text("ok");
    });

    return app;
};
