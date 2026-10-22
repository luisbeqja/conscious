import type { SandboxProvider } from "../sandbox/sandbox.js";
import { backgroundCapability } from "./background/capability.js";
import { createComputerCapability } from "./computer/capability.js";
import { CapabilityRegistry } from "./registry.js";
import { remindersCapability } from "./reminders/capability.js";
import { createSkillsCapability } from "./skills/capability.js";

export const createRegistry = (sandboxes?: SandboxProvider): CapabilityRegistry => {
    const registry = new CapabilityRegistry().register(remindersCapability).register(backgroundCapability);
    if (!sandboxes) return registry;
    return registry.register(createComputerCapability(sandboxes)).register(createSkillsCapability(sandboxes));
};
