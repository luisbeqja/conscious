import { userIdOf } from "../channels/user-id.js";
import type { Invites } from "./invites.js";

/** The owner's commands, answered by the channel itself. Undefined: the text is not one of them. */
export type Command = (userId: string, text: string) => string | undefined;

export interface InviteCommandOptions {
    invites: Invites;
    /** Whoever runs this install: the users listed in its settings. Only they invite. */
    isOwner: (userId: string) => boolean;
    /** The Telegram link for an invite, once the bot is running. */
    telegramLink?: (code: string) => string | undefined;
    /** Whether invited numbers can text Conscious on WhatsApp too. */
    whatsapp?: boolean;
}

const COMMANDS = new Set(["/invite", "/invites", "/uninvite"]);
// Phone numbers with the country code, the way WhatsApp and Telegram report them.
const PHONE = /^\+[\d\s().-]{6,}$/;

/**
 * /invite <number> makes a link for a friend, /invites lists who was invited, /uninvite <number>
 * takes access back. They skip the agent: who may talk to Conscious is decided in code.
 */
export const inviteCommands =
    (options: InviteCommandOptions): Command =>
    (userId, text) => {
        const [word = "", ...rest] = text.trim().split(/\s+/);
        // In a group Telegram writes /invite@bot_name; the name is not needed here.
        const command = word.split("@")[0] ?? "";
        if (!COMMANDS.has(command)) return undefined;
        if (!options.isOwner(userId)) return "Only the owner of this Conscious can invite people.";
        if (command === "/invites") return list(options.invites);
        const number = rest.join(" ");
        if (!PHONE.test(number)) return `Write it with their number and country code: ${command} +39 333 123 4567`;
        const friend = userIdOf(number);
        if (command === "/uninvite") {
            return options.invites.revoke(friend)
                ? `${friend} can no longer talk to Conscious. What they saved stays, in case you invite them again.`
                : `${friend} wasn't invited, so there is nothing to take back.`;
        }
        if (options.isOwner(friend)) return `${friend} can already talk to Conscious.`;
        const invite = options.invites.create(friend, userId);
        const link = options.telegramLink?.(invite.code);
        const done = `Invite for ${friend} ✅`;
        if (!link) {
            const reach = options.whatsapp
                ? `${friend} can text Conscious on WhatsApp now.`
                : "Telegram isn't running yet, so there is no link. Try again in a minute.";
            return `${done}\n\n${reach}`;
        }
        return [
            done,
            "Send them this link. It works once, within 7 days, and only from the Telegram account with that number:",
            link,
            ...(options.whatsapp ? [`They can also text Conscious on WhatsApp from ${friend}.`] : []),
        ].join("\n\n");
    };

const list = (invites: Invites): string => {
    const guests = invites.list();
    if (!guests.length) return "Nobody is invited yet. Invite a friend with /invite +39 333 123 4567";
    const lines = guests.map((guest) =>
        guest.joinedAt
            ? `• ${guest.userId}: on Telegram since ${guest.joinedAt.slice(0, 10)}`
            : `• ${guest.userId}: invited ${guest.invitedAt.slice(0, 10)}, link not used yet`,
    );
    return [
        `Invited (${guests.length}):`,
        ...lines,
        "Take someone's access back with /uninvite and their number.",
    ].join("\n");
};
