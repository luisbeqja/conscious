import { BackgroundAgents, type Notify } from "./agents/background-agents.js";
import { createRegistry } from "./capabilities/index.js";
import type { Config } from "./config.js";
import { InMemoryConversationStore } from "./conversations/store.js";
import { createModelRuntime } from "./engine/models.js";
import { Orchestrator } from "./engine/orchestrator.js";
import { Scheduler } from "./scheduler/scheduler.js";

/**
 * Composition root: which implementation sits behind each seam. `notify` is how Conscious
 * speaks first — a reminder firing, a background task finishing — wherever the user is.
 */
export const createConscious = (config: Config, notify: Notify) => {
    const scheduler = new Scheduler((reminder) => notify(reminder.userId, reminder.text));
    // The runner is only called after startup, once `orchestrator` exists.
    const background: BackgroundAgents = new BackgroundAgents(
        (task, signal): Promise<string> => orchestrator.runBackgroundTask(task, signal),
        notify,
        config.budgets.maxBackgroundAgents,
    );
    const orchestrator = new Orchestrator({
        registry: createRegistry(),
        store: new InMemoryConversationStore(),
        runtime: createModelRuntime(config.model.provider, config.model.id),
        budgets: config.budgets,
        timezone: config.timezone,
        scheduler,
        background,
    });
    return { orchestrator, scheduler, background };
};
