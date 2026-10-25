import { join } from "node:path";
import { ChatBook } from "./channels/chats.js";
import { createTelegramApi, TelegramChannel } from "./channels/telegram.js";
import { userIdOf } from "./channels/user-id.js";
import { loadConfig, loadTelegramConfig } from "./config.js";
import { createConscious } from "./create-conscious.js";
import { modelSetupProblem } from "./engine/models.js";
import { inviteCommands } from "./invites/commands.js";
import { Invites } from "./invites/invites.js";
import { connectServers } from "./mcp/servers.js";
import { createTranscriber } from "./media/transcribe.js";

const config = loadConfig();
const telegram = loadTelegramConfig();
const problem = await modelSetupProblem(config.model);
if (problem || !telegram) {
    console.error(problem ?? "TELEGRAM_BOT_TOKEN is not set; create a bot with @BotFather (see docs/setup.md)");
    process.exit(1);
}
const mcp = await connectServers(config.mcpServers);

// The channel needs the orchestrator and the orchestrator's notifications need the channel.
let notify: (userId: string, text: string) => Promise<void> = async () => {};
const { orchestrator, scheduler, background, sandboxes, startVault } = createConscious(
    config,
    (userId, text) => notify(userId, text),
    mcp.capabilities,
);
// Friends the users on CONSCIOUS_TELEGRAM_USERS invite with /invite.
const invites = new Invites(join(config.dataDir, "invites.json"));
const owners = new Set([...telegram.users.values()].map(userIdOf));
const channel: TelegramChannel = new TelegramChannel(
    createTelegramApi(telegram.botToken),
    orchestrator,
    telegram.users,
    {
        chats: new ChatBook(join(config.dataDir, "chats.json")),
        transcriber: config.transcription && createTranscriber(config.transcription),
        invites,
        command: inviteCommands({
            invites,
            isOwner: (userId) => owners.has(userId),
            telegramLink: (code) => channel.link(code),
        }),
        onJoined: (guest) => {
            channel
                .notify(guest.invitedBy, `${guest.userId} just joined Conscious on Telegram ✅`)
                .catch((error: unknown) => {
                    console.error(`[telegram] could not tell ${guest.invitedBy} that ${guest.userId} joined`, error);
                });
        },
    },
);
notify = channel.notify;
const vaultServer = startVault();
scheduler.start();
background.resume();
console.log(`Conscious on Telegram · ${config.model.provider}/${config.model.id} · ${config.timezone}`);
if (!telegram.users.size) {
    console.log("No one is on CONSCIOUS_TELEGRAM_USERS yet: message the bot, and your id shows here.");
}

const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
        stop.abort();
        scheduler.stopAll();
        vaultServer.close();
        await sandboxes?.shutdown();
        await mcp.close();
        process.exit(0);
    });
}

await channel.listen(stop.signal);
// Listening ends early only when Telegram refuses the token.
if (!stop.signal.aborted) process.exit(1);
