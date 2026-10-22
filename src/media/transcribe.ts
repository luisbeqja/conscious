/** Turns a voice note into text. */
export interface Transcriber {
    name: string;
    transcribe(audio: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<string>;
}

export interface TranscriptionConfig {
    provider: "mistral" | "openai" | "local";
    /** An OpenAI-style API: POST {baseUrl}/audio/transcriptions, multipart with `model` and `file`. */
    baseUrl: string;
    model: string;
    apiKey?: string;
}

const EXTENSIONS: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/amr": "amr",
    "audio/wav": "wav",
    "audio/x-caf": "caf",
    "audio/webm": "webm",
};

/**
 * Mistral (Voxtral), OpenAI and local Whisper servers (whisper.cpp, Speaches, LocalAI) all
 * speak the same transcription API, so one client covers them.
 */
export const createTranscriber = (config: TranscriptionConfig, doFetch: typeof fetch = fetch): Transcriber => ({
    name: config.provider,
    transcribe: async (audio, mimeType, signal) => {
        const type = mimeType.split(";")[0]?.trim() ?? "audio/ogg";
        const form = new FormData();
        form.set("model", config.model);
        form.set("file", new Blob([audio as Uint8Array<ArrayBuffer>], { type }), `voice.${EXTENSIONS[type] ?? "ogg"}`);
        const response = await doFetch(`${config.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
            method: "POST",
            headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
            body: form,
            signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]),
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new Error(`Transcription failed (HTTP ${response.status}) ${detail.slice(0, 200)}`);
        }
        const body = (await response.json()) as { text?: string };
        return (body.text ?? "").trim();
    },
});
