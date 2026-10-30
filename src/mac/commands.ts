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

/** What a Mac's QR sends on Telegram: /start and the code the Mac shows. */
const QR_START = /^\/start mac-([a-z0-9-]{12,14})$/i;
/** A code from a Mac's QR, typed after /mac: `k7qd-m2xa-9wfe`, dashes optional. */
const QR_CODE = /^[a-z0-9]{4}-?[a-z0-9]{4}-?[a-z0-9]{4}$/i;

/**
 * /mac links the user's Mac, /mac new links another in its place, /mac off unlinks it, and
 * /mac <code> (or the QR on the Mac, which sends it) links the Mac that shows that code. They
 * skip the agent: nothing it reads can link a computer to someone's account.
 */
export const macCommands =
    (options: MacCommandOptions): Command =>
    (userId, text) => {
        const scanned = QR_START.exec(text.trim())?.[1];
        const [word = "", ...rest] = text.trim().split(/\s+/);
        // In a group Telegram writes /mac@bot_name; the name is not needed here.
        if (!scanned && word.split("@")[0] !== "/mac") return undefined;
        if (!options.isOwner(userId)) return "Only the owner of this Conscious can link a Mac.";
        const action = (scanned ?? rest.join(" ")).toLowerCase();
        const linked = options.links.linked(userId);
        if (QR_CODE.test(action)) {
            const name = options.links.claim(action, userId);
            return name
                ? `Linking ${name}… it connects in a few seconds.`
                : "That code doesn't work any more: it expired or was already used. Show a new QR on your Mac.";
        }
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
            "On your Mac, in the Conscious folder, run `pnpm mac`: it opens a page with a QR code. Scan it with this phone.",
            "No browser there? Run this instead; it works once, for 15 minutes:",
            `pnpm mac pair ${options.publicUrl.replace(/\/$/, "")} ${pairing.code}`,
        ].join("\n\n");
    };
