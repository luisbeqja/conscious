/** A header value with non-ASCII text, encoded so every mail server reads it. */
const encodeHeader = (value: string) =>
    /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

export interface DraftInput {
    from?: string;
    to: string;
    subject: string;
    body: string;
    cc?: string;
    inReplyTo?: string;
}

/** An RFC 2822 message in plain text. Header values cannot carry new lines. */
export const rfc822 = (draft: DraftInput, date = new Date()): string => {
    const lines = [
        ...(draft.from ? [`From: ${oneLine(draft.from)}`, `Date: ${date.toUTCString()}`] : []),
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
    return lines.join("\r\n");
};
