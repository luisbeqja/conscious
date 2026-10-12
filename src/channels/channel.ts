/** Where a user is talked to. WhatsApp first; the engine never knows which one it is. */
export interface Channel {
    send(userId: string, text: string): Promise<void>;
}

export interface InboundMessage {
    /** The user's id on the channel: their phone number for WhatsApp. */
    userId: string;
    /** The channel's own id for the message, so a redelivered webhook is handled once. */
    messageId: string;
    text: string;
    receivedAt: Date;
}

/** Prints instead of sending: local development without a WhatsApp number. */
export class ConsoleChannel implements Channel {
    async send(userId: string, text: string): Promise<void> {
        console.log(`[to ${userId}] ${text}`);
    }
}
