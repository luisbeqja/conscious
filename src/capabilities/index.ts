import type { Connector } from "../plugins/connectors.js";
import { type PluginDeps, userConnectors } from "../plugins/plugins.js";
import type { SandboxProvider } from "../sandbox/sandbox.js";
import type { Vault } from "../vault/vault.js";
import { backgroundCapability } from "./background/capability.js";
import { createComputerCapability } from "./computer/capability.js";
import { createPluginsCapability } from "./plugins/capability.js";
import { reactionsCapability } from "./reactions/capability.js";
import { CapabilityRegistry } from "./registry.js";
import { remindersCapability } from "./reminders/capability.js";
import { createSkillsCapability } from "./skills/capability.js";
import type { Capability } from "./types.js";
import { createVaultCapability } from "./vault/capability.js";

/** Plugins and the Vault that holds their accounts. */
export interface PluginOptions {
    plugins: PluginDeps;
    vault: { vault: Vault; publicUrl: string };
    /** Accounts connected by signing in, such as Google, when this install is set up for them. */
    signInConnectors?: readonly Connector[];
}

/** `extra` are capabilities found at startup, such as the tools of connected MCP servers. */
export const createRegistry = (
    sandboxes?: SandboxProvider,
    extra: readonly Capability[] = [],
    plugins?: PluginOptions,
): CapabilityRegistry => {
    const registry = new CapabilityRegistry()
        .register(remindersCapability)
        .register(backgroundCapability)
        .register(reactionsCapability);
    for (const capability of extra) registry.register(capability);
    if (plugins) {
        registry
            .register(
                createVaultCapability(plugins.vault.vault, plugins.vault.publicUrl, (userId) => [
                    ...(plugins.signInConnectors ?? []),
                    ...userConnectors(plugins.plugins, userId),
                ]),
            )
            .register(createPluginsCapability(plugins.plugins));
    }
    if (!sandboxes) return registry;
    return registry.register(createComputerCapability(sandboxes)).register(createSkillsCapability(sandboxes));
};
