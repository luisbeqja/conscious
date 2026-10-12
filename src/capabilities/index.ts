import type { CalendarConnector } from "../connectors/connector.js";
import { backgroundCapability } from "./background/capability.js";
import { calendarCapability } from "./calendar/capability.js";
import { CapabilityRegistry } from "./registry.js";
import { remindersCapability } from "./reminders/capability.js";

export interface Connectors {
    calendar?: CalendarConnector;
}

export const createRegistry = (connectors: Connectors): CapabilityRegistry => {
    const registry = new CapabilityRegistry().register(remindersCapability).register(backgroundCapability);
    if (connectors.calendar) registry.register(calendarCapability(connectors.calendar));
    return registry;
};
