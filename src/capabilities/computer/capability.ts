import { posix } from "node:path";
import { Type } from "typebox";
import { promptFile } from "../../prompts/prompt-file.js";
import type { SandboxProvider } from "../../sandbox/sandbox.js";
import { type Capability, defineTool } from "../types.js";

// Keep the end of long output: errors and results are usually last.
const MAX_OUTPUT_CHARS = 6_000;
const MAX_FILE_CHARS = 12_000;
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 300;
const MAX_SEND_BYTES = 15_000_000;

const MIME_TYPES: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    csv: "text/csv",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    ics: "text/calendar",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    mp4: "video/mp4",
    zip: "application/zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const mimeTypeOf = (name: string): string =>
    MIME_TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

const tail = (text: string): string =>
    text.length <= MAX_OUTPUT_CHARS
        ? text
        : `…(${text.length - MAX_OUTPUT_CHARS} characters cut)\n${text.slice(-MAX_OUTPUT_CHARS)}`;

/** Conscious's own computer: a shell and files in the user's sandbox, where its memory lives too. */
export const createComputerCapability = (sandboxes: SandboxProvider): Capability => {
    const runCommand = defineTool({
        name: "computer_run_command",
        label: "Run a command",
        description:
            "Run a shell command on your computer (Linux, bash). Returns the exit code, stdout and stderr. Use it to compute, convert files, or run scripts you wrote.",
        effect: "draft",
        parameters: Type.Object({
            command: Type.String(),
            cwd: Type.Optional(Type.String({ description: "Working directory, relative to home. Defaults to home." })),
            timeoutSeconds: Type.Optional(
                Type.Number({ minimum: 1, maximum: MAX_TIMEOUT_SECONDS, default: DEFAULT_TIMEOUT_SECONDS }),
            ),
        }),
        execute: async (params, context) => {
            const sandbox = await sandboxes.forUser(context.userId);
            const result = await sandbox.run(params.command, {
                cwd: params.cwd,
                timeoutMs: Math.min(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS) * 1000,
            });
            return { data: { exitCode: result.exitCode, stdout: tail(result.stdout), stderr: tail(result.stderr) } };
        },
    });

    const readFile = defineTool({
        name: "computer_read_file",
        label: "Read a file",
        description: "Read a text file on your computer. Paths are relative to home.",
        effect: "read",
        parameters: Type.Object({ path: Type.String() }),
        execute: async (params, context) => {
            const content = await (await sandboxes.forUser(context.userId)).readFile(params.path);
            if (content === undefined) return { data: { exists: false } };
            if (content.length <= MAX_FILE_CHARS) return { data: { exists: true, content } };
            return {
                data: { exists: true, content: content.slice(0, MAX_FILE_CHARS) },
                guidance: `Only the first ${MAX_FILE_CHARS} of ${content.length} characters. Use a command (sed, grep, tail) for the rest.`,
            };
        },
    });

    const writeFile = defineTool({
        name: "computer_write_file",
        label: "Write a file",
        description:
            "Create or replace a text file on your computer. Missing folders are created. Paths are relative to home.",
        effect: "draft",
        parameters: Type.Object({ path: Type.String(), content: Type.String() }),
        execute: async (params, context) => {
            await (await sandboxes.forUser(context.userId)).writeFile(params.path, params.content);
            return { data: { written: params.path } };
        },
    });

    const listFiles = defineTool({
        name: "computer_list_files",
        label: "List files",
        description: "List a folder on your computer. Paths are relative to home; omit for home itself.",
        effect: "read",
        parameters: Type.Object({ path: Type.Optional(Type.String()) }),
        execute: async (params, context) => ({
            data: await (await sandboxes.forUser(context.userId)).listFiles(params.path ?? "."),
        }),
    });

    const sendFile = defineTool({
        name: "computer_send_file",
        label: "Send a file",
        description:
            "Send a file from your computer into the user's chat: a PDF you made, a converted spreadsheet, a chart, a photo.",
        effect: "draft",
        parameters: Type.Object({
            path: Type.String({ description: "Relative to home, e.g. files/trip-plan.pdf" }),
        }),
        execute: async (params, context) => {
            if (!context.sendFile) {
                return { data: { error: "Files can only be sent while answering the user's message." } };
            }
            const data = await (await sandboxes.forUser(context.userId)).readBytes(params.path);
            if (data === undefined) return { data: { error: `There is no ${params.path}.` } };
            if (data.length > MAX_SEND_BYTES) return { data: { error: "Too big to send in a chat (over 15 MB)." } };
            const name = posix.basename(params.path);
            await context.sendFile({ name, mimeType: mimeTypeOf(name), data });
            return {
                data: { sent: name },
                guidance: "The file is in the chat already. Do not describe it again; say what it is in one line.",
            };
        },
    });

    return {
        id: "computer",
        summary: "Your own Linux computer: files, a shell, and your memory of the user.",
        skill: promptFile(import.meta.url, "SKILL.md"),
        tools: [runCommand, readFile, writeFile, listFiles, sendFile],
    };
};
