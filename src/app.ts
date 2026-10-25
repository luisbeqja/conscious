import { startAppChannel, toAppTasks } from "./channels/app.js";
import { loadAppConfig, loadConfig } from "./config.js";
import { createConscious } from "./create-conscious.js";
import { modelSetupProblem } from "./engine/models.js";
import { connectServers } from "./mcp/servers.js";

const config = loadConfig();
// Alone, the app talks as "me", the same user as the terminal chat.
const app = loadAppConfig(process.env, "me");
const problem = await modelSetupProblem(config.model);
if (problem || !app) {
    console.error(problem ?? "The app has no users; set CONSCIOUS_APP_USERS");
    process.exit(1);
}
const mcp = await connectServers(config.mcpServers);

// The channel needs the orchestrator and the orchestrator's notifications need the channel.
let notify: (userId: string, text: string) => Promise<void> = async () => {};
const { orchestrator, scheduler, background, sandboxes, vaultPage, vaultUpgrade, startVault } = createConscious(
    config,
    (userId, text) => notify(userId, text),
    mcp.capabilities,
);
// On one port (a host that gives the service a single address), the app's server serves the Vault too.
const onePort = app.port === config.vault.port;
const { channel, server } = startAppChannel(
    orchestrator,
    app,
    config.dataDir,
    onePort ? vaultPage : undefined,
    onePort ? vaultUpgrade : undefined,
);
notify = channel.notify;
const vaultServer = onePort ? undefined : startVault();
scheduler.start();
background.onChange((userId) => channel.showTasks(userId, toAppTasks(background.list(userId))));
background.resume();
console.log(`Conscious in the app · ${config.model.provider}/${config.model.id} · ${config.timezone}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
        scheduler.stopAll();
        server.close();
        vaultServer?.close();
        await sandboxes?.shutdown();
        await mcp.close();
        process.exit(0);
    });
}
