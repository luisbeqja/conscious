import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type Api, createProvider, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export interface ModelRuntime {
    model: Model<Api>;
    streamFn: StreamFn;
}

export interface ModelConfig {
    provider: string;
    id: string;
    /** For `local`: the server's OpenAI-compatible endpoint, e.g. Ollama's http://localhost:11434/v1. */
    baseUrl?: string;
    /** For `local`, when the server wants one. Hosted providers read their usual variable instead. */
    apiKey?: string;
}

/** Any server that speaks the OpenAI chat API on your own machine or network: Ollama, LM Studio, vLLM. */
const localProvider = (config: ModelConfig) => {
    if (!config.baseUrl)
        throw new Error('Provider "local" needs CONSCIOUS_MODEL_BASE_URL, e.g. http://localhost:11434/v1');
    const model: Model<"openai-completions"> = {
        id: config.id,
        name: config.id,
        api: "openai-completions",
        provider: "local",
        baseUrl: config.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
    };
    return createProvider({
        id: "local",
        name: "Local model",
        baseUrl: config.baseUrl,
        // Most local servers take no key, but the client always sends one.
        auth: {
            apiKey: { name: "Local model key", resolve: async () => ({ auth: { apiKey: config.apiKey ?? "local" } }) },
        },
        models: [model],
        api: openAICompletionsApi(),
    });
};

const loadModels = (config: ModelConfig): MutableModels => {
    const models = builtinModels();
    if (config.provider === "local") models.setProvider(localProvider(config));
    return models;
};

/** Every provider pi-ai knows, plus `local`. Hosted providers read their usual key, e.g. MISTRAL_API_KEY. */
export const createModelRuntime = (config: ModelConfig): ModelRuntime => {
    const models = loadModels(config);
    const providers = models.getProviders().map((provider) => provider.id);
    if (!providers.includes(config.provider)) {
        throw new Error(`Model provider "${config.provider}" is not supported. Use one of: ${providers.join(", ")}`);
    }
    const model = models.getModel(config.provider, config.id);
    if (!model) {
        const known = models
            .getModels(config.provider)
            .map((candidate) => candidate.id)
            .slice(0, 15);
        throw new Error(
            `Model "${config.id}" is not in the ${config.provider} catalog. Some it has: ${known.join(", ")}`,
        );
    }
    return { model, streamFn: (streamed, context, options) => models.streamSimple(streamed, context, options) };
};

/** Undefined when the provider has what it needs to run, otherwise what to set. */
export const modelSetupProblem = async (config: ModelConfig): Promise<string | undefined> => {
    if (config.provider === "local") return undefined;
    const models = loadModels(config);
    if (await models.checkAuth(config.provider)) return undefined;
    const name = models.getProvider(config.provider)?.name ?? config.provider;
    return `No credentials for ${name}. Set its API key in .env (see .env.example) and run again.`;
};
