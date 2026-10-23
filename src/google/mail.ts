import { type DraftInput, rfc822 } from "../mail/rfc822.js";
import { htmlToText } from "../web/html-text.js";

export type { DraftInput };

interface Part {
    mimeType?: string;
    filename?: string;
    headers?: { name: string; value: string }[];
    body?: { data?: string; size?: number; attachmentId?: string };
    parts?: Part[];
}

export interface GmailMessage {
    id: string;
    threadId: string;
    snippet?: string;
    labelIds?: string[];
    payload?: Part;
}

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

export const header = (message: GmailMessage, name: string): string | undefined =>
    message.payload?.headers?.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value;

const walk = (part: Part | undefined, found: Part[] = []): Part[] => {
    if (!part) return found;
    found.push(part);
    for (const child of part.parts ?? []) walk(child, found);
    return found;
};

/** The readable body: the plain-text part when there is one, else the HTML one as text. */
export const messageText = (message: GmailMessage): string => {
    const parts = walk(message.payload);
    const plain = parts.find((part) => part.mimeType === "text/plain" && part.body?.data && !part.filename);
    if (plain?.body?.data) return decode(plain.body.data).trim();
    const html = parts.find((part) => part.mimeType === "text/html" && part.body?.data && !part.filename);
    if (html?.body?.data) return htmlToText(decode(html.body.data)).text;
    return message.snippet ?? "";
};

export const attachmentNames = (message: GmailMessage): string[] =>
    walk(message.payload)
        .filter((part) => part.filename)
        .map((part) => part.filename as string);

/** An RFC 2822 message, base64url as the Gmail API wants it. */
export const rawMessage = (draft: DraftInput): string => Buffer.from(rfc822(draft), "utf8").toString("base64url");
