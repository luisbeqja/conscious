import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Sandbox } from "../sandbox/sandbox.js";

/** A file the user sent with their message: a photo, a PDF, a spreadsheet. */
export interface IncomingFile {
    name: string;
    mimeType: string;
    data: Uint8Array;
}

/** A file going to the user from Conscious's computer. */
export type OutgoingFile = IncomingFile;

export const INBOX = "files/inbox";
// Above this a photo is saved to the computer instead of shown to the model.
const MAX_IMAGE_BYTES = 5_000_000;
const MAX_INLINE_CHARS = 12_000;
const MODEL_IMAGES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const TEXT = /^(text\/|application\/(json|xml|csv))/;

const size = (bytes: number) =>
    bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;

/** A name safe as a file name on the computer: no folders, no leading dots. */
export const safeName = (name: string, mimeType: string): string => {
    const base = (name.split(/[\\/]/).pop() ?? "")
        .replace(/[^\w.\- ]+/g, "_")
        .replace(/^\.+/, "")
        .trim();
    if (base) return base.slice(-100);
    const extension = mimeType.split("/")[1]?.split(/[;+]/)[0] ?? "bin";
    return `file.${extension}`;
};

export interface PreparedFiles {
    /** Lines for the user's turn: what came in and where it is. */
    notes: string[];
    images: ImageContent[];
}

/**
 * What the agent gets for the files in a message. Photos go to the model when it can see; every
 * file is saved to the computer, where skills can open it; without a computer, small text files
 * are put in the message and the rest are only named.
 */
export const prepareFiles = async (
    files: readonly IncomingFile[],
    options: { seesImages: boolean; sandbox?: Sandbox; now?: Date },
): Promise<PreparedFiles> => {
    const notes: string[] = [];
    const images: ImageContent[] = [];
    const stamp = (options.now ?? new Date()).toISOString().slice(0, 16).replace(/[:T]/g, "-");
    for (const file of files) {
        const label = `${file.name || "a file"} (${file.mimeType}, ${size(file.data.length)})`;
        const shown = options.seesImages && MODEL_IMAGES.has(file.mimeType) && file.data.length <= MAX_IMAGE_BYTES;
        if (shown)
            images.push({ type: "image", data: Buffer.from(file.data).toString("base64"), mimeType: file.mimeType });
        if (options.sandbox) {
            const path = `${INBOX}/${stamp}-${safeName(file.name, file.mimeType)}`;
            await options.sandbox.writeFile(path, file.data);
            notes.push(
                `The user sent ${label}${shown ? ", shown to you above" : ""}. Saved on your computer at ${path}.`,
            );
            continue;
        }
        if (shown) {
            notes.push(`The user sent ${label}, shown to you above.`);
        } else if (TEXT.test(file.mimeType)) {
            const text = new TextDecoder().decode(file.data);
            notes.push(
                `The user sent ${label}. Its text${text.length > MAX_INLINE_CHARS ? ", cut short," : ""}:\n<file>\n${text.slice(0, MAX_INLINE_CHARS)}\n</file>`,
            );
        } else {
            notes.push(`The user sent ${label}. You have no computer to open it on; say so.`);
        }
    }
    return { notes, images };
};

/** Photos are kept out of the saved conversation: every later turn would pay for them again. */
export const withoutImages = (messages: AgentMessage[]): AgentMessage[] =>
    messages.map((message) => {
        if (message.role !== "user" || typeof message.content === "string") return message;
        if (!message.content.some((block) => block.type === "image")) return message;
        return {
            ...message,
            content: message.content.map((block) =>
                block.type === "image" ? { type: "text" as const, text: "[a photo the user sent]" } : block,
            ),
        };
    });
