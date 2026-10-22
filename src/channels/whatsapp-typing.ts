import { createClient, type WhatsAppClient } from "@photon-ai/whatsapp-business";
import { cloud } from "@spectrum-ts/core";

interface Line {
    client: WhatsAppClient;
    expiresAt: number;
}

/**
 * WhatsApp's typing indicator. WhatsApp shows it only together with a read receipt for the
 * user's message, and Spectrum drops typing on WhatsApp, so this sends that receipt to the
 * project's line itself. With several lines it uses the first, as Spectrum does for receipts.
 */
export class WhatsAppTyping {
    private line?: Promise<Line>;

    constructor(
        private readonly projectId: string,
        private readonly projectSecret: string,
        private readonly now: () => number = Date.now,
    ) {}

    /** Marks the message read and shows "typing…" until Conscious sends something, or 25 seconds pass. */
    show = async (messageId: string): Promise<void> => {
        const { client } = await this.current();
        // Spectrum ids can carry a ":<part>" suffix after the WhatsApp message id.
        await client.messages.markRead(messageId.split(":")[0] ?? messageId, { typingIndicator: true });
    };

    async close(): Promise<void> {
        const line = await this.line?.catch(() => undefined);
        await line?.client.close();
    }

    private async current(): Promise<Line> {
        const line = await this.line?.catch(() => undefined);
        if (line && this.now() < line.expiresAt) return line;
        this.line = this.open(line);
        return this.line;
    }

    private async open(expired?: Line): Promise<Line> {
        await expired?.client.close().catch(() => {});
        const tokens = await cloud.issueWhatsappBusinessTokens(this.projectId, this.projectSecret);
        const [phoneNumberId, accessToken] = Object.entries(tokens.auth)[0] ?? [];
        if (!phoneNumberId || !accessToken) throw new Error("this Photon project has no WhatsApp line");
        return {
            client: createClient({ accessToken, appSecret: "", phoneNumberId }),
            // Renew a minute early so a call never goes out with a token about to lapse.
            expiresAt: this.now() + (tokens.expiresIn - 60) * 1000,
        };
    }
}
