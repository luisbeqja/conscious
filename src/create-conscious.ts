import { join } from "node:path";
import { BackgroundAgents, type Notify } from "./agents/background-agents.js";
import { createRegistry } from "./capabilities/index.js";
import type { Capability } from "./capabilities/types.js";
import type { Config } from "./config.js";
import { SandboxConversationStore } from "./conversations/sandbox-store.js";
import { InMemoryConversationStore } from "./conversations/store.js";
import { createModelRuntime } from "./engine/models.js";
import { Orchestrator, SentLog } from "./engine/orchestrator.js";
import { fetchTransport } from "./plugins/broker.js";
import { manifestProblems } from "./plugins/manifest.js";
import { loadPluginFolder, type PluginDeps, pluginCapabilities } from "./plugins/plugins.js";
import { PluginInstalls, PluginRegistry } from "./plugins/registry.js";
import { NodeSandbox } from "./plugins/sandbox/sandbox.js";
import { persistPlugins } from "./plugins/state-file.js";
import { createE2BClient, E2BSandboxes } from "./sandbox/e2b.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { SkillLibrary } from "./skills/library.js";
import { createVaultServer, verifyWithService } from "./vault/server.js";
import { loadOrCreateVaultKey, Vault } from "./vault/vault.js";

/**
 * Composition root: which implementation sits behind each seam. `notify` is how Conscious
 * speaks first — a reminder firing, a background task finishing — wherever the user is.
 */
export const createConscious = (config: Config, notify: Notify, extra: readonly Capability[] = []) => {
    const sandboxes = config.sandbox
        ? new E2BSandboxes(createE2BClient(config.sandbox), config.sandbox.idleMs)
        : undefined;
    // Background results reach the orchestrator their own way; everything else it hears about here.
    const sent = new SentLog();
    const say: Notify = (userId, text) => {
        sent.record(userId, text);
        return notify(userId, text);
    };
    const scheduler = new Scheduler((reminder) => say(reminder.userId, reminder.text));
    // The runner is only called after startup, once `orchestrator` exists.
    const background: BackgroundAgents = new BackgroundAgents(
        (task, signal): Promise<string> => orchestrator.runBackgroundTask(task, signal),
        notify,
        config.budgets.maxBackgroundAgents,
    );
    const vault = new Vault({
        key: loadOrCreateVaultKey(config.dataDir, config.vault.key),
        file: join(config.dataDir, "vault.json"),
    });
    const plugins: PluginDeps = {
        registry: new PluginRegistry(),
        installs: new PluginInstalls(),
        sandbox: new NodeSandbox(),
        credentials: vault,
        transport: fetchTransport,
    };
    const registry = createRegistry(sandboxes, extra, {
        plugins,
        vault: { vault, publicUrl: config.vault.publicUrl },
    }).addSource(pluginCapabilities(plugins));
    plugins.registry.reserve(registry.ids());
    persistPlugins(join(config.dataDir, "plugins.json"), plugins.registry, plugins.installs);
    // The repository's plugins were reviewed as pull requests, so every user can install them.
    for (const pkg of loadPluginFolder(config.pluginsDir)) {
        const problems = manifestProblems(pkg.manifest);
        if (problems.length) throw new Error(`plugins/${pkg.manifest.id}: ${problems.join("; ")}`);
        plugins.registry.seed(pkg);
    }
    const orchestrator = new Orchestrator({
        registry,
        store: sandboxes ? new SandboxConversationStore(sandboxes) : new InMemoryConversationStore(),
        runtime: createModelRuntime(config.model),
        budgets: config.budgets,
        timezone: config.timezone,
        scheduler,
        background,
        sandboxes,
        skills: config.sandbox ? new SkillLibrary({ internet: config.sandbox.internet }) : undefined,
        sent,
    });
    /** Serves the Vault page. When a secret is saved, the user hears it in the chat. */
    const startVault = () => {
        const server = createVaultServer({
            vault,
            verify: verifyWithService,
            onConnected: (userId, connector) =>
                say(userId, `${connector.name} is connected ✅ You can ask me about it now.`),
        });
        server.listen(config.vault.port);
        return server;
    };
    return { orchestrator, scheduler, background, sandboxes, plugins, vault, startVault };
};
