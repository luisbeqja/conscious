import type { SandboxProvider } from "../sandbox/sandbox.js";
import { backgroundCapability } from "./background/capability.js";
import { createComputerCapability } from "./computer/capability.js";
import { CapabilityRegistry } from "./registry.js";
import { remindersCapability } from "./reminders/capability.js";
import { createSkillsCapability } from "./skills/capability.js";
import type { Capability } from "./types.js";

/** `extra` are capabilities found at startup, such as the tools of connected MCP servers. */
export const createRegistry = (sandboxes?: SandboxProvider, extra: readonly Capability[] = []): CapabilityRegistry => {
    const registry = new CapabilityRegistry().register(remindersCapability).register(backgroundCapability);
    for (const capability of extra) registry.register(capability);
    if (!sandboxes) return registry;
    return registry.register(createComputerCapability(sandboxes)).register(createSkillsCapability(sandboxes));
};
