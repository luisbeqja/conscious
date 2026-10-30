import type { Command } from "../invites/commands.js";
import type { MacLinks } from "./links.js";
import type { MacBridge } from "./server.js";

export interface MacCommandOptions {
    links: MacLinks;
    bridge: MacBridge;
    /** Where the Mac reaches this install. */
    publicUrl: string;
    /** Only the owners link a Mac: it runs Claude Code on their own computer. */
    isOwner: (userId: string) => boolean;
}

/**
 * /mac links the user's Mac, /mac new links another in its place, /mac off unlinks it. They skip
 * the agent: nothing it reads can link a computer to someone's account.
 */
export const macCommands =
    (options: MacCommandOptions): Command =>
    (userId, text) => {
        const [word = "", ...rest] = text.trim().split(/\s+/);
        // In a group Telegram writes /mac@bot_name; the name is not needed here.
        if (word.split("@")[0] !== "/mac") return undefined;
        if (!options.isOwner(userId)) return "Only the owner of this Conscious can link a Mac.";
        const action = rest.join(" ").toLowerCase();
        const linked = options.links.linked(userId);
        if (action === "off") {
            options.bridge.disconnect(userId);
            return options.links.forget(userId)
                ? `${linked?.name ?? "Your Mac"} is unlinked: I can't reach it any more. On the Mac, \`pnpm mac uninstall\` stops conscious-mac.`
                : "No Mac is linked, so there is nothing to unlink.";
        }
        if (action && action !== "new")
            return "Send /mac to link your Mac, /mac new for another one, /mac off to unlink it.";
        if (linked && action !== "new") {
            const online = options.bridge.status(userId)?.online;
            return `${linked.name} is linked, and ${online ? "online" : "offline right now"}. /mac new links another Mac in its place, /mac off unlinks it.`;
        }
        const pairing = options.links.startPairing(userId);
        return [
            "On your Mac, in the Conscious folder, with Claude Code installed and signed in, run:",
            `pnpm mac pair ${options.publicUrl.replace(/\/$/, "")} ${pairing.code}`,
            "The code works once, for 15 minutes. Then allow each folder Claude Code may work in with `pnpm mac allow <folder>`, and keep it running with `pnpm mac install`.",
        ].join("\n\n");
    };
