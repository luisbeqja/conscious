import type { WhatsAppConfig } from "../../config.js";
import type { Channel } from "../channel.js";

const GRAPH_URL = "https://graph.facebook.com/v21.0";
// WhatsApp rejects a text body over 4096 characters.
const MAX_BODY = 4096;

export const splitMessage = (text: string, max = MAX_BODY): string[] => {
    const parts: string[] = [];
    let rest = text.trim();
    while (rest.length > max) {
        const cut = rest.lastIndexOf("\n", max);
        const at = cut > max / 2 ? cut : max;
        parts.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
    }
    if (rest) parts.push(rest);
    return parts;
};

export class WhatsAppChannel implements Channel {
    constructor(private readonly config: WhatsAppConfig) {}

    async send(userId: string, text: string): Promise<void> {
        for (const body of splitMessage(text)) {
            const response = await fetch(`${GRAPH_URL}/${this.config.phoneNumberId}/messages`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${this.config.accessToken}`,
                    "content-type": "application/json",
                },
                body: JSON.stringify({ messaging_product: "whatsapp", to: userId, type: "text", text: { body } }),
            });
            if (!response.ok) {
                throw new Error(`WhatsApp send failed (${response.status}): ${await response.text()}`);
            }
        }
    }
}
