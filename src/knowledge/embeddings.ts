/** Turns text into vectors, so a search can find passages that mean the same thing in other words. */
export interface Embedder {
    /** Saved in an index, so a search only compares vectors made by the same model. */
    model: string;
    embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

export interface EmbeddingsConfig {
    provider: "mistral" | "openai" | "local";
    /** An OpenAI-style API: POST {baseUrl}/embeddings with `model` and `input`. */
    baseUrl: string;
    model: string;
    apiKey?: string;
}

/** A request the service refused. A 400, 413 or 422 usually means the batch was too big. */
export class EmbeddingsError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

const RETRIES = 6;
const MAX_WAIT_SECONDS = 30;

/**
 * Mistral, OpenAI and local servers (Ollama, LM Studio, vLLM) all speak the same embeddings API,
 * so one client covers them. Vectors come back with length 1, so a dot product is their cosine.
 */
export const createEmbedder = (config: EmbeddingsConfig, doFetch: typeof fetch = fetch): Embedder => ({
    model: config.model,
    embed: async (texts, signal) => {
        for (let attempt = 0; ; attempt++) {
            const response = await doFetch(`${config.baseUrl.replace(/\/$/, "")}/embeddings`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
                },
                body: JSON.stringify({ model: config.model, input: texts }),
                signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
            });
            // Rate limits and busy servers pass: wait as asked, or 1, 2, 4… seconds.
            if ((response.status === 429 || response.status >= 500) && attempt < RETRIES) {
                const asked = Number(response.headers.get("retry-after"));
                await response.body?.cancel();
                await pause(Math.min(asked > 0 ? asked : 2 ** attempt, MAX_WAIT_SECONDS) * 1000, signal);
                continue;
            }
            if (!response.ok) {
                const detail = await response.text().catch(() => "");
                throw new EmbeddingsError(
                    `Embeddings failed (HTTP ${response.status}) ${detail.slice(0, 200)}`,
                    response.status,
                );
            }
            const body = (await response.json()) as { data?: { index: number; embedding: number[] }[] };
            const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
            if (data.length !== texts.length) {
                throw new Error(`Embeddings returned ${data.length} vectors for ${texts.length} texts`);
            }
            return data.map((item) => normalize(Float32Array.from(item.embedding)));
        }
    },
});

/** Waits, unless the signal gives up first. */
const pause = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(signal.reason);
            },
            { once: true },
        );
    });

export const normalize = (vector: Float32Array): Float32Array => {
    let sum = 0;
    for (const value of vector) sum += value * value;
    const length = Math.sqrt(sum) || 1;
    return vector.map((value) => value / length);
};
