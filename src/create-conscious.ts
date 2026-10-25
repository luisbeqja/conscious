import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type RequestListener } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { BackgroundAgents, type Notify } from "./agents/background-agents.js";
import { AgentStore } from "./agents/resting-agents.js";
import { E2BBrowsers } from "./browser/browser.js";
import { LiveViews, relayLiveView, serveLiveView } from "./browser/live-view.js";
import { createAgentsCapability } from "./capabilities/agents/capability.js";
import { createBrowserCapability } from "./capabilities/browser/capability.js";
import { composioReaches, createComposioCapability } from "./capabilities/composio/capability.js";
import { createGoogleCapability } from "./capabilities/google/capability.js";
import { createRegistry } from "./capabilities/index.js";
import { createItalyCapability } from "./capabilities/italy/capability.js";
import { createMailCapability, verifyMailbox } from "./capabilities/mail/capability.js";
import { createMemoryCapability } from "./capabilities/memory/capability.js";
import { createQuietCapability } from "./capabilities/quiet/capability.js";
import { createShopCapability } from "./capabilities/shop/capability.js";
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
import { createEmbedder } from "./knowledge/embeddings.js";
import { KnowledgeIndex } from "./knowledge/store.js";
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
import { ShopClient } from "./shop/client.js";
import { SHOP_CONNECTOR, ShopSignIn } from "./shop/sign-in.js";
import { SkillLibrary } from "./skills/library.js";
import { SPOTIFY_CONNECTOR, SpotifyOAuth } from "./spotify/oauth.js";
import {
    CONNECTED_PATH,
    type DeviceSignInProvider,
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
    // The agents kept between background jobs live where memory does.
    const agents = sandboxes ? AgentStore.onComputer(sandboxes) : AgentStore.onHost(join(config.dataDir, "agents"));
    // A browser per user, signed in through live views that the Vault's server relays.
    const browsers = config.browser && sandboxes ? new E2BBrowsers(config.browser) : undefined;
    const liveViews = browsers ? new LiveViews(config.vault.publicUrl) : undefined;
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
    const italy = openItalyIndex(config);
    const throughComposio = (...apps: string[]) =>
        config.composio !== undefined && composioReaches(config.composio.apps, ...apps);
    const callback = (connectorId: string) =>
        `${config.vault.publicUrl.replace(/\/$/, "")}${signInCallbackPath(connectorId)}`;
    const google = config.google ? new GoogleOAuth(config.google, callback(GOOGLE_CONNECTOR.id), vault) : undefined;
    const mcpSignIns = config.mcpServers
        .filter((entry) => entry.auth === "oauth")
        .map((entry) => new McpSignIn(entry, callback(`mcp-${entry.name}`), vault));
    const mcpUsers = new McpUserServers(mcpSignIns, vault);
    const signIns = new Map<string, SignInProvider | DeviceSignInProvider>(
        mcpSignIns.map((signIn) => [signIn.connector.id, signIn]),
    );
    const spotify = config.spotify
        ? new SpotifyOAuth(config.spotify, callback(SPOTIFY_CONNECTOR.id), vault)
        : undefined;
    // Shop needs no app of its own: the user approves Conscious on Shop's page with a code.
    const shop = config.shop ? new ShopSignIn(vault) : undefined;
    if (google) signIns.set(GOOGLE_CONNECTOR.id, google);
    if (spotify) signIns.set(SPOTIFY_CONNECTOR.id, spotify);
    if (shop) signIns.set(SHOP_CONNECTOR.id, shop);
    const builtIn = [
        createMemoryCapability(memory),
        createAgentsCapability(agents),
        ...(browsers && liveViews && sandboxes ? [createBrowserCapability(browsers, liveViews, sandboxes)] : []),
        createQuietCapability(pacing),
        web,
        createMailCapability(openImap, vault),
        ...(italy ? [createItalyCapability(italy)] : []),
        ...(google ? [createGoogleCapability(new GoogleApi(google), vault)] : []),
        ...(spotify ? [createSpotifyCapability(spotify, vault)] : []),
        ...(shop ? [createShopCapability(new ShopClient(), shop, sandboxes)] : []),
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
        // An app Composio reaches is not missing: the agent signs the user in through Composio instead.
        unconfigured: [
            ...(google || throughComposio("googlecalendar", "gmail", "googledrive", "googletasks")
                ? []
                : [
                      {
                          id: GOOGLE_CONNECTOR.id,
                          name: "Google (Calendar, Gmail, Drive, Contacts, Tasks)",
                          setup: `create an OAuth client of type Web application in Google Cloud with the redirect URI ${callback(GOOGLE_CONNECTOR.id)}, set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, and restart Conscious. The README section "Google" has the steps.`,
                      },
                  ]),
            ...(spotify || throughComposio("spotify")
                ? []
                : [
                      {
                          id: SPOTIFY_CONNECTOR.id,
                          name: "Spotify",
                          setup: `create an app at developer.spotify.com with the redirect URI ${callback(SPOTIFY_CONNECTOR.id).replace("//localhost", "//127.0.0.1")}, set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env, and restart Conscious. The README section "Spotify" has the steps.`,
                      },
                  ]),
        ],
        elsewhere: {
            ...(!google && throughComposio("googlecalendar", "gmail", "googledrive", "googletasks")
                ? {
                      google: "On this install Google (Calendar, Gmail, Drive, Tasks) connects through Composio, not the Vault: call composio_connect_app with googlecalendar, gmail, googledrive or googletasks, and send that link.",
                  }
                : {}),
            ...(!spotify && throughComposio("spotify")
                ? {
                      spotify:
                          "On this install Spotify connects through Composio, not the Vault: call composio_connect_app with spotify, and send that link.",
                  }
                : {}),
        },
        signInConnectors: [
            MAIL_CONNECTOR,
            ...(google ? [GOOGLE_CONNECTOR] : []),
            ...(spotify ? [SPOTIFY_CONNECTOR] : []),
            ...(shop ? [SHOP_CONNECTOR] : []),
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
        agents,
    });
    /** The Vault page. When a secret is saved, the user hears it in the chat. */
    const vaultPages = vaultHandler({
        vault,
        verify: (connector, secret) =>
            connector.id === MAIL_CONNECTOR.id ? verifyMailbox(openImap, secret) : verifyWithService(connector, secret),
        signIns,
        onConnected: (userId, connector) =>
            say(userId, `${connector.name} is connected ✅ You can ask me about it now.`),
    });
    const showLiveView = liveViews && serveLiveView(liveViews);
    /** The Vault's pages, and the live views of the users' browsers beside them. */
    const vaultPage: RequestListener = (request, response) => {
        if (showLiveView?.(request, response)) return;
        return vaultPages(request, response);
    };
    const relay = liveViews && relayLiveView(liveViews);
    /** The live views' sockets. False for any other upgrade, which the caller refuses. */
    const vaultUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): boolean =>
        relay?.(request, socket, head) ?? false;
    /** Serves the Vault page on a port of its own. */
    const startVault = () => {
        const server = createServer(vaultPage);
        server.on("upgrade", (request, socket, head) => {
            if (!vaultUpgrade(request, socket, head)) socket.destroy();
        });
        return server.listen(config.vault.port);
    };
    return {
        orchestrator,
        scheduler,
        background,
        sandboxes,
        plugins,
        vault,
        mcpUsers,
        vaultPage,
        vaultUpgrade,
        startVault,
    };
};

/** The official Italian pages, when this install has an index of them (`pnpm italy:index`). */
const openItalyIndex = (config: Config): KnowledgeIndex | undefined => {
    if (!existsSync(config.italyIndex)) return undefined;
    const index = KnowledgeIndex.open(config.italyIndex, config.embeddings && createEmbedder(config.embeddings));
    if (index.model && !index.semantic) {
        console.warn(
            `[italy] the index was built with ${index.model}, ${config.embeddings ? `but this install embeds with ${config.embeddings.model}` : "but no embeddings are set up"}: searching by keywords only. Rebuild it with pnpm italy:index, or set CONSCIOUS_EMBEDDINGS to match.`,
        );
    } else {
        console.log(
            `[italy] ${index.size} official pages, searched by words${index.model ? ` and meaning (${index.model})` : ""}`,
        );
    }
    return index;
};
