import type { Capability, RegisteredTool } from "./types.js";

export class CapabilityRegistry {
    private readonly capabilities = new Map<string, Capability>();

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

    async available(userId: string): Promise<Capability[]> {
        const all = [...this.capabilities.values()];
        const offered = await Promise.all(
            all.map(async (capability) => (await capability.available?.(userId)) ?? true),
        );
        return all.filter((_, index) => offered[index]);
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
