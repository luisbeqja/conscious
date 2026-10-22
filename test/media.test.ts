import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createComputerCapability } from "../src/capabilities/computer/capability.js";
import type { ToolContext } from "../src/capabilities/types.js";
import { type OutgoingFile, prepareFiles, safeName, withoutImages } from "../src/media/incoming.js";
import { createTranscriber } from "../src/media/transcribe.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { FakeSandbox, FakeSandboxes } from "./fake-sandbox.js";

const photo = { name: "IMG_1.jpg", mimeType: "image/jpeg", data: new Uint8Array([255, 216, 255]) };
const pdf = { name: "../../ticket.pdf", mimeType: "application/pdf", data: new Uint8Array([37, 80, 68, 70]) };
const csv = { name: "list.csv", mimeType: "text/csv", data: new TextEncoder().encode("milk,eggs") };
const now = new Date("2026-10-22T18:30:00Z");

describe("Files the user sends", () => {
    it("shows photos to a model that can see, and saves every file on the computer", async () => {
        const sandbox = new FakeSandbox();
        const prepared = await prepareFiles([photo, pdf], { seesImages: true, sandbox, now });
        expect(prepared.images).toEqual([{ type: "image", mimeType: "image/jpeg", data: "/9j/" }]);
        expect(prepared.notes[0]).toMatch(
            /shown to you above\. Saved on your computer at files\/inbox\/2026-10-22-18-30-IMG_1\.jpg/,
        );
        expect(prepared.notes[1]).toContain("files/inbox/2026-10-22-18-30-ticket.pdf");
        expect([...sandbox.bytes.keys()]).toEqual([
            "/home/user/files/inbox/2026-10-22-18-30-IMG_1.jpg",
            "/home/user/files/inbox/2026-10-22-18-30-ticket.pdf",
        ]);
    });

    it("without a computer, puts small text files in the message and names the rest", async () => {
        const prepared = await prepareFiles([csv, pdf], { seesImages: false, now });
        expect(prepared.notes[0]).toContain("<file>\nmilk,eggs\n</file>");
        expect(prepared.notes[1]).toMatch(/no computer to open it/);
        expect(prepared.images).toEqual([]);
    });

    it("keeps file names inside the inbox", () => {
        expect(safeName("../../etc/passwd", "text/plain")).toBe("passwd");
        expect(safeName(".hidden", "text/plain")).toBe("hidden");
        expect(safeName("", "image/png")).toBe("file.png");
    });

    it("keeps photos out of the saved conversation", () => {
        const messages = [
            {
                role: "user",
                content: [
                    { type: "text", text: "what is this?" },
                    { type: "image", data: "AAAA", mimeType: "image/png" },
                ],
                timestamp: 1,
            },
        ] as unknown as AgentMessage[];
        expect(JSON.stringify(withoutImages(messages))).not.toContain("AAAA");
        expect(JSON.stringify(withoutImages(messages))).toContain("[a photo the user sent]");
    });
});

describe("Voice notes", () => {
    it("asks an OpenAI-style transcription API, with the key", async () => {
        let seen: { url: string; auth?: string; model?: unknown; file?: unknown } | undefined;
        const doFetch = (async (url: string, init: RequestInit) => {
            const form = init.body as FormData;
            seen = {
                url,
                auth: (init.headers as Record<string, string>).authorization,
                model: form.get("model"),
                file: (form.get("file") as File).name,
            };
            return Response.json({ text: " ciao, ricordami il latte " });
        }) as unknown as typeof fetch;
        const transcriber = createTranscriber(
            { provider: "mistral", baseUrl: "https://api.mistral.ai/v1/", model: "voxtral-mini-latest", apiKey: "k" },
            doFetch,
        );
        expect(await transcriber.transcribe(new Uint8Array([1]), "audio/ogg; codecs=opus")).toBe(
            "ciao, ricordami il latte",
        );
        expect(seen).toEqual({
            url: "https://api.mistral.ai/v1/audio/transcriptions",
            auth: "Bearer k",
            model: "voxtral-mini-latest",
            file: "voice.ogg",
        });
    });
});

describe("Sending files from the computer", () => {
    const sandboxes = new FakeSandboxes();
    const send = createComputerCapability(sandboxes).tools.find((tool) => tool.name === "computer_send_file");
    const base: ToolContext = { userId: "me", timezone: "Europe/Rome", scheduler: new Scheduler(async () => {}) };

    it("sends a file into the chat with its type", async () => {
        const sent: OutgoingFile[] = [];
        const sandbox = await sandboxes.forUser("me");
        await sandbox.writeFile("files/plan.pdf", new Uint8Array([37, 80]));
        const output = await send?.execute(
            { path: "files/plan.pdf" },
            { ...base, sendFile: async (file) => void sent.push(file) },
        );
        expect(output?.data).toEqual({ sent: "plan.pdf" });
        expect(sent).toEqual([{ name: "plan.pdf", mimeType: "application/pdf", data: new Uint8Array([37, 80]) }]);
    });

    it("explains when there is no chat to send to, or no file", async () => {
        expect((await send?.execute({ path: "files/plan.pdf" }, base))?.data).toMatchObject({
            error: expect.stringMatching(/while answering/),
        });
        const missing = await send?.execute({ path: "nope.pdf" }, { ...base, sendFile: async () => {} });
        expect(missing?.data).toEqual({ error: "There is no nope.pdf." });
    });
});
