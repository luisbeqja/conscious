import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** How long an invite link works. */
const INVITE_DAYS = 7;
const DAY_MS = 86_400_000;

/** A link the owner sends a friend. It works once, within a week. */
export interface Invite {
    code: string;
    /** Who it is for: their phone number, the id Conscious knows them by on every channel. */
    userId: string;
    invitedBy: string;
    createdAt: string;
    expiresAt: string;
    /** The Telegram account that last opened the link and has yet to share its number. */
    claimedBy?: string;
    usedAt?: string;
}

/** Someone the owner invited: allowed on WhatsApp at once, on Telegram once the link is used. */
export interface Guest {
    userId: string;
    invitedBy: string;
    invitedAt: string;
    telegramId?: string;
    joinedAt?: string;
}

interface Saved {
    invites: Invite[];
    guests: Guest[];
}

/** Codes look like `inv-k7qdm2xa9w`: short enough for a Telegram start link, about 50 bits. */
const newCode = (): string =>
    `inv-${[...randomBytes(10)].map((byte) => "abcdefghjkmnpqrstuvwxyz23456789"[byte % 31]).join("")}`;

/**
 * The friends the owner invited, and the links that bring them in. Kept in the data folder
 * (owner-only), so access survives a restart; the owners themselves stay in the settings.
 */
export class Invites {
    private invites: Invite[] = [];
    private guests: Guest[] = [];

    /** Without a file, invites live in this process only. */
    constructor(
        private readonly file?: string,
        private readonly now: () => Date = () => new Date(),
    ) {
        if (file && existsSync(file)) {
            const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<Saved>;
            this.invites = saved.invites ?? [];
            this.guests = saved.guests ?? [];
        }
    }

    /** A new link for `userId`, who may text Conscious on WhatsApp from now on. */
    create(userId: string, invitedBy: string): Invite {
        const now = this.now();
        // Links nobody used in time are only clutter.
        this.invites = this.invites.filter((invite) => invite.usedAt || new Date(invite.expiresAt) > now);
        const invite: Invite = {
            code: newCode(),
            userId,
            invitedBy,
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + INVITE_DAYS * DAY_MS).toISOString(),
        };
        this.invites.push(invite);
        if (!this.guest(userId)) this.guests.push({ userId, invitedBy, invitedAt: invite.createdAt });
        this.save();
        return invite;
    }

    allows(userId: string): boolean {
        return this.guest(userId) !== undefined;
    }

    /** The user a Telegram account is, once it joined through an invite. */
    telegramUser(telegramId: string): string | undefined {
        return this.guests.find((guest) => guest.telegramId === telegramId)?.userId;
    }

    /** Notes that this Telegram account opened the link. False when the link no longer works. */
    claim(code: string, telegramId: string): boolean {
        const invite = this.usable(code);
        if (!invite) return false;
        // The latest to open it; only the one whose number matches gets in.
        invite.claimedBy = telegramId;
        this.save();
        return true;
    }

    /** The invite this Telegram account opened and has yet to finish. */
    claimedBy(telegramId: string): Invite | undefined {
        return this.invites.find((invite) => invite.claimedBy === telegramId && this.usable(invite.code));
    }

    /** Uses up the invite and makes the Telegram account the person it was for. */
    redeem(code: string, telegramId: string): Guest | undefined {
        const invite = this.usable(code);
        const guest = invite && this.guest(invite.userId);
        if (!invite || !guest) return undefined;
        const now = this.now().toISOString();
        invite.usedAt = now;
        // One person per Telegram account.
        for (const other of this.guests) if (other.telegramId === telegramId) delete other.telegramId;
        guest.telegramId = telegramId;
        guest.joinedAt = now;
        this.save();
        return guest;
    }

    /** Takes access back, with any link still out. False when `userId` was not invited. */
    revoke(userId: string): boolean {
        const known = this.allows(userId);
        this.guests = this.guests.filter((guest) => guest.userId !== userId);
        this.invites = this.invites.filter((invite) => invite.userId !== userId);
        this.save();
        return known;
    }

    list(): readonly Guest[] {
        return this.guests;
    }

    private guest(userId: string): Guest | undefined {
        return this.guests.find((guest) => guest.userId === userId);
    }

    /** A link that still works: not used, not expired, and its guest not taken back. */
    private usable(code: string): Invite | undefined {
        const invite = this.invites.find((entry) => entry.code === code);
        if (!invite || invite.usedAt || new Date(invite.expiresAt) <= this.now()) return undefined;
        return this.guest(invite.userId) ? invite : undefined;
    }

    private save(): void {
        if (!this.file) return;
        const saved: Saved = { invites: this.invites, guests: this.guests };
        mkdirSync(dirname(this.file), { recursive: true });
        const temporary = `${this.file}.tmp`;
        writeFileSync(temporary, JSON.stringify(saved, null, 2), { mode: 0o600 });
        renameSync(temporary, this.file);
    }
}
