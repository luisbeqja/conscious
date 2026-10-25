import { join } from "node:path";
import { type PlatformProviderConfig, Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import { whatsappBusiness } from "@spectrum-ts/whatsapp-business";
import { type AppChannel, startAppChannel, toAppTasks } from "./channels/app.js";
import { ChatBook } from "./channels/chats.js";
import { PhotonChannel } from "./channels/photon.js";
import { createTelegramApi, TELEGRAM, TelegramChannel } from "./channels/telegram.js";
import { userIdOf } from "./channels/user-id.js";
import { WhatsAppTyping } from "./channels/whatsapp-typing.js";
import {
    loadAppConfig,
    loadConfig,
    loadPhotonConfig,
    loadTelegramConfig,
    type PhotonPlatform,
    type TelegramConfig,
} from "./config.js";
import { createConscious } from "./create-conscious.js";
import { modelSetupProblem } from "./engine/models.js";
import { connectServers } from "./mcp/servers.js";
import { createTranscriber } from "./media/transcribe.js";

// With Spectrum Cloud credentials, both providers take their numbers and lines from the project.
const PROVIDERS: Record<PhotonPlatform, () => PlatformProviderConfig> = {
    imessage: () => imessage.config(),
    whatsapp: () => whatsappBusiness.config(),
};

const config = loadConfig();
const photon = loadPhotonConfig();
// Optional: the phone app next to WhatsApp and iMessage, for users listed in CONSCIOUS_APP_USERS.
const appConfig = loadAppConfig();
const app = appConfig && { ...appConfig, users: appConfig.users.map(userIdOf) };
// Optional: a Telegram bot next to them, for users listed in CONSCIOUS_TELEGRAM_USERS.
// A mistake in its settings turns Telegram off, never WhatsApp with it.
let telegram: TelegramConfig | undefined;
try {
    telegram = loadTelegramConfig();
} catch (error) {
    console.error(`[telegram] ${error instanceof Error ? error.message : error}; Telegram is off until it is fixed`);
}
const problem = await modelSetupProblem(config.model);
if (problem) {
    console.error(problem);
    process.exit(1);
}
const mcp = await connectServers(config.mcpServers);

// The channels need the orchestrator and the orchestrator's notifications need the channels.
let channel: PhotonChannel | undefined;
let appChannel: AppChannel | undefined;
let telegramChannel: TelegramChannel | undefined;
const chats = new ChatBook(join(config.dataDir, "chats.json"));
const { orchestrator, scheduler, background, sandboxes, vaultPage, vaultUpgrade, startVault } = createConscious(
    config,
    // Conscious speaks first where the user last wrote: the app, Telegram or their messaging chat.
    (userId, text) => {
        const chat = chats.get(userId);
        if (appChannel?.hasUser(userId) && appChannel.wroteHereSince(userId, chat?.lastInboundAt)) {
            return appChannel.notify(userId, text);
        }
        if (telegramChannel && chat?.platform === TELEGRAM) return telegramChannel.notify(userId, text);
        return channel ? channel.notify(userId, text) : Promise.resolve();
    },
    mcp.capabilities,
);
// On one port (a host that gives the service a single address), the app's server serves the Vault too.
const onePort = app?.port === config.vault.port;
const appServer =
    app &&
    startAppChannel(
        orchestrator,
        app,
        config.dataDir,
        onePort ? vaultPage : undefined,
        onePort ? vaultUpgrade : undefined,
    );
appChannel = appServer?.channel;
// Spectrum is connected below; a chat is only reopened when a reminder fires, by which time it is.
let spectrum: Awaited<ReturnType<typeof Spectrum>> | undefined;
const whatsappTyping = photon.platforms.includes("whatsapp")
    ? new WhatsAppTyping(photon.projectId, photon.projectSecret)
    : undefined;
const transcriber = config.transcription && createTranscriber(config.transcription);
channel = new PhotonChannel(orchestrator, photon.allowedUsers, {
    chats,
    template: photon.whatsappTemplate,
    transcriber,
    showWhatsAppTyping: whatsappTyping?.show,
    openSpace: async (platform, spaceId) => {
        if (!spectrum) throw new Error("Photon is not connected yet");
        const provider = platform === "imessage" ? imessage : whatsappBusiness;
        return (provider as typeof whatsappBusiness)(spectrum as never).space.get(spaceId);
    },
});
// A Telegram user listed as your number is you on WhatsApp and in the app too.
telegramChannel =
    telegram &&
    new TelegramChannel(createTelegramApi(telegram.botToken), orchestrator, telegram.users, { chats, transcriber });
const stopTelegram = new AbortController();
const vaultServer = onePort ? undefined : startVault();
if (!config.vault.publicUrl.startsWith("https://")) {
    console.warn(
        `Vault links point to ${config.vault.publicUrl}; set CONSCIOUS_PUBLIC_URL to an https address phones can open.`,
    );
}

spectrum = await Spectrum({
    projectId: photon.projectId,
    projectSecret: photon.projectSecret,
    providers: photon.platforms.map((platform) => PROVIDERS[platform]()),
    // Messages are private; nothing about them goes to Photon's telemetry.
    telemetry: false,
});
scheduler.start();
background.onChange((userId) => appChannel?.showTasks(userId, toAppTasks(background.list(userId))));
background.resume();
console.log(
    `Conscious on Photon · ${photon.platforms.join(", ")} · ${config.model.provider}/${config.model.id} · voice notes: ${config.transcription?.provider ?? "off"}`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
        stopTelegram.abort();
        scheduler.stopAll();
        vaultServer?.close();
        appServer?.server.close();
        await sandboxes?.shutdown();
        await mcp.close();
        await whatsappTyping?.close();
        await spectrum?.stop();
        process.exit(0);
    });
}

// Telegram asks for its messages on its own, beside Spectrum's stream.
void telegramChannel?.listen(stopTelegram.signal);
await channel.listen(spectrum.messages);
