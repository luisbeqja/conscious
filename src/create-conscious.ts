import { join } from "node:path";
import { BackgroundAgents, type Notify } from "./agents/background-agents.js";
import { createGoogleCapability } from "./capabilities/google/capability.js";
import { createRegistry } from "./capabilities/index.js";
import { createMailCapability, verifyMailbox } from "./capabilities/mail/capability.js";
import { createSpotifyCapability } from "./capabilities/spotify/capability.js";
import type { Capability } from "./capabilities/types.js";
import { createWebCapability } from "./capabilities/web/capability.js";
import type { Config } from "./config.js";
import { FileConversationStore } from "./conversations/file-store.js";
import { SandboxConversationStore } from "./conversations/sandbox-store.js";
import { createModelRuntime } from "./engine/models.js";
import { Orchestrator, SentLog } from "./engine/orchestrator.js";
import { GoogleApi } from "./google/api.js";
import { GOOGLE_CONNECTOR, GoogleOAuth } from "./google/oauth.js";
import { MAIL_CONNECTOR } from "./mail/account.js";
import { openImap } from "./mail/imap.js";
import { McpSignIn, McpUserServers } from "./mcp/sign-in.js";
import { fetchTransport } from "./plugins/broker.js";
import { manifestProblems } from "./plugins/manifest.js";
import { loadPluginFolder, type PluginDeps, pluginCapabilities } from "./plugins/plugins.js";
import { PluginInstalls, PluginRegistry } from "./plugins/registry.js";
import { NodeSandbox } from "./plugins/sandbox/sandbox.js";
import { persistPlugins } from "./plugins/state-file.js";
import { createE2BClient, E2BSandboxes } from "./sandbox/e2b.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { SkillLibrary } from "./skills/library.js";
import { SPOTIFY_CONNECTOR, SpotifyOAuth } from "./spotify/oauth.js";
import { createVaultServer, type SignInProvider, signInCallbackPath, verifyWithService } from "./vault/server.js";
import { loadOrCreateVaultKey, Vault } from "./vault/vault.js";
import { createSearchProvider } from "./web/search.js";

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
    // The fire callback runs only after `start`, once `orchestrator` exists.
    const scheduler: Scheduler = new Scheduler(
        async (reminder, late) => {
            if (!reminder.check) {
                const text = late ? `${reminder.text}\n\n(Late: I was offline when this was due.)` : reminder.text;
                return say(reminder.userId, text);
            }
            const text = await orchestrator.runCheck(reminder);
            if (text) await say(reminder.userId, text);
        },
        { file: join(config.dataDir, "reminders.json") },
    );
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
    const web = createWebCapability({ search: createSearchProvider(config.search) });
    const callback = (connectorId: string) =>
        `${config.vault.publicUrl.replace(/\/$/, "")}${signInCallbackPath(connectorId)}`;
    const google = config.google ? new GoogleOAuth(config.google, callback(GOOGLE_CONNECTOR.id), vault) : undefined;
    const mcpSignIns = config.mcpServers
        .filter((entry) => entry.auth === "oauth")
        .map((entry) => new McpSignIn(entry, callback(`mcp-${entry.name}`), vault));
    const mcpUsers = new McpUserServers(mcpSignIns, vault);
    const signIns = new Map<string, SignInProvider>(mcpSignIns.map((signIn) => [signIn.connector.id, signIn]));
    const spotify = config.spotify
        ? new SpotifyOAuth(config.spotify, callback(SPOTIFY_CONNECTOR.id), vault)
        : undefined;
    if (google) signIns.set(GOOGLE_CONNECTOR.id, google);
    if (spotify) signIns.set(SPOTIFY_CONNECTOR.id, spotify);
    const builtIn = [
        web,
        createMailCapability(openImap, vault),
        ...(google ? [createGoogleCapability(new GoogleApi(google), vault)] : []),
        ...(spotify ? [createSpotifyCapability(spotify, vault)] : []),
    ];
    const registry = createRegistry(sandboxes, [...builtIn, ...extra], {
        plugins,
        vault: { vault, publicUrl: config.vault.publicUrl },
        signInConnectors: [
            MAIL_CONNECTOR,
            ...(google ? [GOOGLE_CONNECTOR] : []),
            ...(spotify ? [SPOTIFY_CONNECTOR] : []),
            ...mcpSignIns.map((signIn) => signIn.connector),
        ],
    })
        .addSource(mcpUsers.capabilities)
        .addSource(pluginCapabilities(plugins));
    plugins.registry.reserve([...registry.ids(), ...mcpSignIns.map((signIn) => signIn.entry.name)]);
    persistPlugins(join(config.dataDir, "plugins.json"), plugins.registry, plugins.installs);
    // The repository's plugins were reviewed as pull requests, so every user can install them.
    for (const pkg of loadPluginFolder(config.pluginsDir)) {
        const problems = manifestProblems(pkg.manifest);
        if (problems.length) throw new Error(`plugins/${pkg.manifest.id}: ${problems.join("; ")}`);
        plugins.registry.seed(pkg);
    }
    const orchestrator = new Orchestrator({
        registry,
        store: sandboxes
            ? new SandboxConversationStore(sandboxes)
            : new FileConversationStore(join(config.dataDir, "conversations")),
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
            verify: (connector, secret) =>
                connector.id === MAIL_CONNECTOR.id
                    ? verifyMailbox(openImap, secret)
                    : verifyWithService(connector, secret),
            signIns,
            onConnected: (userId, connector) =>
                say(userId, `${connector.name} is connected ✅ You can ask me about it now.`),
        });
        server.listen(config.vault.port);
        return server;
    };
    return { orchestrator, scheduler, background, sandboxes, plugins, vault, mcpUsers, startVault };
};
