import { createServer } from "node:http";
import { join } from "node:path";
import { BackgroundAgents, type Notify } from "./agents/background-agents.js";
import { createComposioCapability } from "./capabilities/composio/capability.js";
import { createGoogleCapability } from "./capabilities/google/capability.js";
import { createRegistry } from "./capabilities/index.js";
import { createMailCapability, verifyMailbox } from "./capabilities/mail/capability.js";
import { createMemoryCapability } from "./capabilities/memory/capability.js";
import { createQuietCapability } from "./capabilities/quiet/capability.js";
import { createSpotifyCapability } from "./capabilities/spotify/capability.js";
import type { Capability } from "./capabilities/types.js";
import { createWebCapability } from "./capabilities/web/capability.js";
import { ComposioClient } from "./composio/client.js";
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
import { FileMemoryStore, type MemoryStore, SandboxMemoryStore } from "./memory/memory.js";
import { fetchTransport } from "./plugins/broker.js";
import { manifestProblems } from "./plugins/manifest.js";
import { loadPluginFolder, type PluginDeps, pluginCapabilities } from "./plugins/plugins.js";
import { PluginInstalls, PluginRegistry } from "./plugins/registry.js";
import { NodeSandbox } from "./plugins/sandbox/sandbox.js";
import { persistPlugins } from "./plugins/state-file.js";
import { createE2BClient, E2BSandboxes } from "./sandbox/e2b.js";
import { Pacing } from "./scheduler/pacing.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { SkillLibrary } from "./skills/library.js";
import { SPOTIFY_CONNECTOR, SpotifyOAuth } from "./spotify/oauth.js";
import {
    CONNECTED_PATH,
    type SignInProvider,
    signInCallbackPath,
    vaultHandler,
    verifyWithService,
} from "./vault/server.js";
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
    const memory: MemoryStore = sandboxes
        ? new SandboxMemoryStore(sandboxes)
        : new FileMemoryStore(join(config.dataDir, "memory"));
    // Background results reach the orchestrator their own way; everything else it hears about here.
    const sent = new SentLog();
    const say: Notify = (userId, text) => {
        sent.record(userId, text);
        return notify(userId, text);
    };
    const pacing = new Pacing(config.pacing, join(config.dataDir, "pacing.json"));
    // The fire callback runs only after `start`, once `orchestrator` exists.
    const scheduler: Scheduler = new Scheduler(
        async (reminder, late) => {
            const pace = pacing.decide(reminder);
            if (pace.action === "skip") return console.log(`[pacing] held ${reminder.id}: ${pace.reason}`);
            if (pace.action === "defer") {
                const { id, createdAt, cron, ...again } = reminder;
                scheduler.add({ ...again, at: pace.to });
                return console.log(`[pacing] ${id} waits until ${pace.to.toISOString()}, out of quiet hours`);
            }
            const text = !reminder.check
                ? late
                    ? `${reminder.text}\n\n(Sorry this is late, I was offline when it was due.)`
                    : reminder.text
                : await orchestrator.runCheck(reminder);
            if (!text) return;
            await say(reminder.userId, text);
            pacing.record(reminder);
        },
        { file: join(config.dataDir, "reminders.json") },
    );
    // The runner is only called after startup, once `orchestrator` exists.
    const background: BackgroundAgents = new BackgroundAgents(
        (task, signal): Promise<string> => orchestrator.runBackgroundTask(task, signal),
        notify,
        config.budgets.maxBackgroundAgents,
        join(config.dataDir, "background.json"),
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
        createMemoryCapability(memory),
        createQuietCapability(pacing),
        web,
        createMailCapability(openImap, vault),
        ...(google ? [createGoogleCapability(new GoogleApi(google), vault)] : []),
        ...(spotify ? [createSpotifyCapability(spotify, vault)] : []),
        ...(config.composio
            ? [
                  createComposioCapability(
                      new ComposioClient(config.composio),
                      (app) =>
                          `${config.vault.publicUrl.replace(/\/$/, "")}${CONNECTED_PATH}?app=${encodeURIComponent(app)}`,
                      config.composio.apps,
                  ),
              ]
            : []),
    ];
    const registry = createRegistry(sandboxes, [...builtIn, ...extra], {
        plugins,
        vault: { vault, publicUrl: config.vault.publicUrl },
        unconfigured: [
            ...(google
                ? []
                : [
                      {
                          id: GOOGLE_CONNECTOR.id,
                          name: "Google (Calendar, Gmail, Drive, Contacts, Tasks)",
                          setup: `create an OAuth client of type Web application in Google Cloud with the redirect URI ${callback(GOOGLE_CONNECTOR.id)}, set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, and restart Conscious. The README section "Google" has the steps.`,
                      },
                  ]),
            ...(spotify
                ? []
                : [
                      {
                          id: SPOTIFY_CONNECTOR.id,
                          name: "Spotify",
                          setup: `create an app at developer.spotify.com with the redirect URI ${callback(SPOTIFY_CONNECTOR.id).replace("//localhost", "//127.0.0.1")}, set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env, and restart Conscious. The README section "Spotify" has the steps.`,
                      },
                  ]),
        ],
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
        memory,
        skills: config.sandbox ? new SkillLibrary({ internet: config.sandbox.internet }) : undefined,
        sent,
    });
    /** The Vault page. When a secret is saved, the user hears it in the chat. */
    const vaultPage = vaultHandler({
        vault,
        verify: (connector, secret) =>
            connector.id === MAIL_CONNECTOR.id ? verifyMailbox(openImap, secret) : verifyWithService(connector, secret),
        signIns,
        onConnected: (userId, connector) =>
            say(userId, `${connector.name} is connected ✅ You can ask me about it now.`),
    });
    /** Serves the Vault page on a port of its own. */
    const startVault = () => createServer(vaultPage).listen(config.vault.port);
    return { orchestrator, scheduler, background, sandboxes, plugins, vault, mcpUsers, vaultPage, startVault };
};
