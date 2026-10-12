import { backgroundCapability } from "./background/capability.js";
import { CapabilityRegistry } from "./registry.js";
import { remindersCapability } from "./reminders/capability.js";

export const createRegistry = (): CapabilityRegistry =>
    new CapabilityRegistry().register(remindersCapability).register(backgroundCapability);
