import { startAppChannel } from "./channels/app.js";
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
const { orchestrator, scheduler, sandboxes, startVault } = createConscious(
    config,
    (userId, text) => notify(userId, text),
    mcp.capabilities,
);
const { channel, server } = startAppChannel(orchestrator, app, config.dataDir);
notify = channel.notify;
const vaultServer = startVault();
scheduler.start();
console.log(`Conscious in the app · ${config.model.provider}/${config.model.id} · ${config.timezone}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
        scheduler.stopAll();
        server.close();
        vaultServer.close();
        await sandboxes?.shutdown();
        await mcp.close();
        process.exit(0);
    });
}
