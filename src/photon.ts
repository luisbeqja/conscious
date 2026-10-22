import { join } from "node:path";
import { type PlatformProviderConfig, Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import { whatsappBusiness } from "@spectrum-ts/whatsapp-business";
import { ChatBook } from "./channels/chats.js";
import { PhotonChannel } from "./channels/photon.js";
import { loadConfig, loadPhotonConfig, type PhotonPlatform } from "./config.js";
import { createConscious } from "./create-conscious.js";
import { modelSetupProblem } from "./engine/models.js";
import { connectServers } from "./mcp/servers.js";

// With Spectrum Cloud credentials, both providers take their numbers and lines from the project.
const PROVIDERS: Record<PhotonPlatform, () => PlatformProviderConfig> = {
    imessage: () => imessage.config(),
    whatsapp: () => whatsappBusiness.config(),
};

const config = loadConfig();
const photon = loadPhotonConfig();
const problem = await modelSetupProblem(config.model);
if (problem) {
    console.error(problem);
    process.exit(1);
}
const mcp = await connectServers(config.mcpServers);

// The channel needs the orchestrator and the orchestrator's notifications need the channel.
let channel: PhotonChannel | undefined;
const { orchestrator, scheduler, sandboxes, startVault } = createConscious(
    config,
    (userId, text) => (channel ? channel.notify(userId, text) : Promise.resolve()),
    mcp.capabilities,
);
// Spectrum is connected below; a chat is only reopened when a reminder fires, by which time it is.
let spectrum: Awaited<ReturnType<typeof Spectrum>> | undefined;
channel = new PhotonChannel(orchestrator, photon.allowedUsers, {
    chats: new ChatBook(join(config.dataDir, "chats.json")),
    template: photon.whatsappTemplate,
    openSpace: async (platform, spaceId) => {
        if (!spectrum) throw new Error("Photon is not connected yet");
        const provider = platform === "imessage" ? imessage : whatsappBusiness;
        return (provider as typeof whatsappBusiness)(spectrum as never).space.get(spaceId);
    },
});
const vaultServer = startVault();
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
console.log(`Conscious on Photon · ${photon.platforms.join(", ")} · ${config.model.provider}/${config.model.id}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
        scheduler.stopAll();
        vaultServer.close();
        await sandboxes?.shutdown();
        await mcp.close();
        await spectrum?.stop();
        process.exit(0);
    });
}

await channel.listen(spectrum.messages);
