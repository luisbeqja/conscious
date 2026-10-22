import { BackgroundAgents, type Notify } from "./agents/background-agents.js";
import { createRegistry } from "./capabilities/index.js";
import type { Capability } from "./capabilities/types.js";
import type { Config } from "./config.js";
import { SandboxConversationStore } from "./conversations/sandbox-store.js";
import { InMemoryConversationStore } from "./conversations/store.js";
import { createModelRuntime } from "./engine/models.js";
import { Orchestrator } from "./engine/orchestrator.js";
import { createE2BClient, E2BSandboxes } from "./sandbox/e2b.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { SkillLibrary } from "./skills/library.js";

/**
 * Composition root: which implementation sits behind each seam. `notify` is how Conscious
 * speaks first — a reminder firing, a background task finishing — wherever the user is.
 */
export const createConscious = (config: Config, notify: Notify, extra: readonly Capability[] = []) => {
    const sandboxes = config.sandbox
        ? new E2BSandboxes(createE2BClient(config.sandbox), config.sandbox.idleMs)
        : undefined;
    const scheduler = new Scheduler((reminder) => notify(reminder.userId, reminder.text));
    // The runner is only called after startup, once `orchestrator` exists.
    const background: BackgroundAgents = new BackgroundAgents(
        (task, signal): Promise<string> => orchestrator.runBackgroundTask(task, signal),
        notify,
        config.budgets.maxBackgroundAgents,
    );
    const orchestrator = new Orchestrator({
        registry: createRegistry(sandboxes, extra),
        store: sandboxes ? new SandboxConversationStore(sandboxes) : new InMemoryConversationStore(),
        runtime: createModelRuntime(config.model.provider, config.model.id),
        budgets: config.budgets,
        timezone: config.timezone,
        scheduler,
        background,
        sandboxes,
        skills: config.sandbox ? new SkillLibrary({ internet: config.sandbox.internet }) : undefined,
    });
    return { orchestrator, scheduler, background, sandboxes };
};
