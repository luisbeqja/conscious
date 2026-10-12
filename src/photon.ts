import { type PlatformProviderConfig, Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import { whatsappBusiness } from "@spectrum-ts/whatsapp-business";
import { PhotonChannel } from "./channels/photon.js";
import { loadConfig, loadPhotonConfig, type PhotonPlatform } from "./config.js";
import { createConscious } from "./create-conscious.js";

// With Spectrum Cloud credentials, both providers take their numbers and lines from the project.
const PROVIDERS: Record<PhotonPlatform, () => PlatformProviderConfig> = {
    imessage: () => imessage.config(),
    whatsapp: () => whatsappBusiness.config(),
};

const config = loadConfig();
const photon = loadPhotonConfig();

// The channel needs the orchestrator and the orchestrator's notifications need the channel.
let channel: PhotonChannel | undefined;
const { orchestrator, scheduler } = createConscious(config, (userId, text) =>
    channel ? channel.notify(userId, text) : Promise.resolve(),
);
channel = new PhotonChannel(orchestrator, photon.allowedUsers);

const spectrum = await Spectrum({
    projectId: photon.projectId,
    projectSecret: photon.projectSecret,
    providers: photon.platforms.map((platform) => PROVIDERS[platform]()),
    // Messages are private; nothing about them goes to Photon's telemetry.
    telemetry: false,
});
console.log(`Conscious on Photon · ${photon.platforms.join(", ")} · ${config.model.provider}/${config.model.id}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
        scheduler.stopAll();
        await spectrum.stop();
        process.exit(0);
    });
}

await channel.listen(spectrum.messages);
