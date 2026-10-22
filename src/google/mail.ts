import { htmlToText } from "../web/html-text.js";

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

/** A header value with non-ASCII text, encoded so every mail server reads it. */
const encodeHeader = (value: string) =>
    /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

export interface DraftInput {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    inReplyTo?: string;
}

/** An RFC 2822 message, base64url as the Gmail API wants it. Header values cannot carry new lines. */
export const rawMessage = (draft: DraftInput): string => {
    const lines = [
        `To: ${oneLine(draft.to)}`,
        ...(draft.cc ? [`Cc: ${oneLine(draft.cc)}`] : []),
        `Subject: ${encodeHeader(oneLine(draft.subject))}`,
        ...(draft.inReplyTo
            ? [`In-Reply-To: ${oneLine(draft.inReplyTo)}`, `References: ${oneLine(draft.inReplyTo)}`]
            : []),
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: 8bit",
        "",
        draft.body.replace(/\r?\n/g, "\r\n"),
    ];
    return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
};
