import type { Capability, RegisteredTool } from "./types.js";

/** Capabilities that differ per user and change at runtime, such as installed plugins. */
export type CapabilitySource = (userId: string) => Promise<Capability[]> | Capability[];

export class CapabilityRegistry {
    private readonly capabilities = new Map<string, Capability>();
    private readonly sources: CapabilitySource[] = [];

    register(capability: Capability): this {
        if (this.capabilities.has(capability.id)) throw new Error(`Capability "${capability.id}" is registered twice`);
        for (const tool of capability.tools) {
            if (!tool.name.startsWith(`${capability.id}_`)) {
                throw new Error(`Tool "${tool.name}" must be named "${capability.id}_<verb>_<noun>"`);
            }
        }
        this.capabilities.set(capability.id, capability);
        return this;
    }

    addSource(source: CapabilitySource): this {
        this.sources.push(source);
        return this;
    }

    ids(): ReadonlySet<string> {
        return new Set(this.capabilities.keys());
    }

    async available(userId: string): Promise<Capability[]> {
        const all = [...this.capabilities.values()];
        const offered = await Promise.all(
            all.map(async (capability) => (await capability.available?.(userId)) ?? true),
        );
        const fixed = all.filter((_, index) => offered[index]);
        // A source can never shadow a registered capability.
        const dynamic = (await Promise.all(this.sources.map((source) => source(userId))))
            .flat()
            .filter((capability) => !this.capabilities.has(capability.id));
        return [...fixed, ...dynamic];
    }

    tools(capabilities: readonly Capability[]): RegisteredTool[] {
        return capabilities.flatMap((capability) => capability.tools);
    }

    renderIndex(capabilities: readonly Capability[]): string {
        return capabilities
            .map((capability) => `## ${capability.id}\n${capability.summary}\n\n${capability.skill}`)
            .join("\n\n");
    }
}
