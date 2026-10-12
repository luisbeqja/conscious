import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type Api, createModels, type Model } from "@earendil-works/pi-ai";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

export interface ModelRuntime {
    model: Model<Api>;
    streamFn: StreamFn;
}

const PROVIDERS = {
    anthropic: anthropicProvider,
    "amazon-bedrock": amazonBedrockProvider,
} as const;

/** Credentials come from the provider's usual environment: ANTHROPIC_API_KEY, or the AWS chain for Bedrock. */
export const createModelRuntime = (provider: string, modelId: string): ModelRuntime => {
    const factory = PROVIDERS[provider as keyof typeof PROVIDERS];
    if (!factory)
        throw new Error(`Model provider "${provider}" is not supported. Use: ${Object.keys(PROVIDERS).join(", ")}`);
    const models = createModels();
    models.setProvider(factory());
    const model = models.getModel(provider, modelId);
    if (!model) throw new Error(`Model "${modelId}" is not in the ${provider} catalog`);
    return { model, streamFn: (streamed, context, options) => models.streamSimple(streamed, context, options) };
};
