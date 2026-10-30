import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** How long a pairing code works. */
const PAIRING_MINUTES = 15;
/** How long a QR on the Mac works, and how many can wait at once: anyone may ask for one. */
const OFFER_MINUTES = 10;
const MAX_OFFERS = 100;

/** A code the owner types on their Mac. It works once, within 15 minutes. */
export interface Pairing {
    code: string;
    userId: string;
    expiresAt: string;
}

/** A Mac a user linked: who it acts for, and a digest of the token it holds. */
export interface LinkedMac {
    userId: string;
    name: string;
    /** SHA-256 of the token, hex. The token itself lives only on the Mac. */
    digest: string;
    pairedAt: string;
    /** Its first connection, when the user was told it is linked. */
    connectedAt?: string;
}

interface Saved {
    pairings: Pairing[];
    macs: LinkedMac[];
    offers: Offer[];
}

/**
 * A Mac asking to be linked: it shows its code as a QR, and the owner sends the code from their
 * chat. Only the Mac that asked holds the secret that collects the token. Saved with the links, so
 * a restart of Conscious does not void a QR someone is about to scan.
 */
interface Offer {
    code: string;
    /** SHA-256 of the secret, hex. */
    secret: string;
    name: string;
    expiresAt: number;
    /** Who sent the code, once someone did. */
    userId?: string;
}

const digestOf = (token: string): Buffer => createHash("sha256").update(token).digest();

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Codes look like `k7qd-m2xa-9wfe`: easy to type on a Mac, about 59 bits. */
const newCode = (): string =>
    [...randomBytes(12)]
        .map((byte, index) => `${index && index % 4 === 0 ? "-" : ""}${ALPHABET[byte % ALPHABET.length]}`)
        .join("");

/** Typed with or without dashes, in any case. */
const normalize = (code: string): string => code.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The Macs users linked to Conscious, one per user, and the codes that link them. Kept in the
 * data folder (owner-only) with a digest of each token, never the token.
 */
export class MacLinks {
    private pairings: Pairing[] = [];
    private macs: LinkedMac[] = [];
    private offers: Offer[] = [];

    /** Without a file, links live in this process only. */
    constructor(
        private readonly file?: string,
        private readonly now: () => Date = () => new Date(),
    ) {
        if (file && existsSync(file)) {
            const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<Saved>;
            this.pairings = saved.pairings ?? [];
            this.macs = saved.macs ?? [];
            this.offers = saved.offers ?? [];
        }
    }

    /** A new code for `userId`. Any code they had before stops working. */
    startPairing(userId: string): Pairing {
        const now = this.now();
        this.pairings = this.pairings.filter(
            (pairing) => pairing.userId !== userId && new Date(pairing.expiresAt) > now,
        );
        const pairing: Pairing = {
            code: newCode(),
            userId,
            expiresAt: new Date(now.getTime() + PAIRING_MINUTES * 60_000).toISOString(),
        };
        this.pairings.push(pairing);
        this.save();
        return pairing;
    }

    /**
     * Uses up a code and links the Mac that typed it, in place of the user's old one. The token is
     * returned this once; undefined when the code is wrong, used or expired.
     */
    pair(code: string, name: string): { userId: string; token: string } | undefined {
        const now = this.now();
        const given = normalize(code);
        const pairing = this.pairings.find(
            (entry) => normalize(entry.code) === given && new Date(entry.expiresAt) > now,
        );
        if (!pairing) return undefined;
        this.pairings = this.pairings.filter((entry) => entry !== pairing);
        return { userId: pairing.userId, token: this.link(pairing.userId, name) };
    }

    /** A code for a Mac to show as a QR, and the secret it collects its token with. */
    offer(name: string): { code: string; secret: string; expiresAt: Date } {
        const now = this.now().getTime();
        this.offers = this.offers.filter((offer) => offer.expiresAt > now).slice(-(MAX_OFFERS - 1));
        const secret = randomBytes(32).toString("base64url");
        const offer: Offer = {
            code: newCode(),
            secret: digestOf(secret).toString("hex"),
            name: name.trim().slice(0, 60) || "Mac",
            expiresAt: now + OFFER_MINUTES * 60_000,
        };
        this.offers.push(offer);
        this.save();
        return { code: offer.code, secret, expiresAt: new Date(offer.expiresAt) };
    }

    /** The owner sent a Mac's code from their chat: that Mac becomes theirs. Its name, or undefined. */
    claim(code: string, userId: string): string | undefined {
        const offer = this.openOffer(code);
        if (!offer || (offer.userId && offer.userId !== userId)) return undefined;
        offer.userId = userId;
        this.save();
        return offer.name;
    }

    /**
     * The token for the Mac that holds the secret, once its code was sent: given this once. "waiting"
     * until then; undefined for a wrong secret or a code that expired.
     */
    collect(code: string, secret: string): { userId: string; token: string } | "waiting" | undefined {
        const offer = this.openOffer(code);
        if (!offer || !timingSafeEqual(Buffer.from(offer.secret, "hex"), digestOf(secret))) return undefined;
        if (!offer.userId) return "waiting";
        this.offers = this.offers.filter((entry) => entry !== offer);
        return { userId: offer.userId, token: this.link(offer.userId, offer.name) };
    }

    /** The Mac that holds this token. */
    macFor(token: string): LinkedMac | undefined {
        const given = digestOf(token);
        return this.macs.find((mac) => timingSafeEqual(Buffer.from(mac.digest, "hex"), given));
    }

    linked(userId: string): LinkedMac | undefined {
        return this.macs.find((mac) => mac.userId === userId);
    }

    /** Notes a Mac's first connection. True only that first time, when the user hears it is linked. */
    connected(mac: LinkedMac): boolean {
        if (mac.connectedAt) return false;
        mac.connectedAt = this.now().toISOString();
        this.save();
        return true;
    }

    private openOffer(code: string): Offer | undefined {
        const given = normalize(code);
        const now = this.now().getTime();
        return this.offers.find((offer) => normalize(offer.code) === given && offer.expiresAt > now);
    }

    /** Links a Mac for the user in place of their old one. Its token, returned only this once. */
    private link(userId: string, name: string): string {
        const token = randomBytes(32).toString("base64url");
        this.macs = this.macs.filter((mac) => mac.userId !== userId);
        this.macs.push({
            userId,
            name: name.trim().slice(0, 60) || "Mac",
            digest: digestOf(token).toString("hex"),
            pairedAt: this.now().toISOString(),
        });
        this.save();
        return token;
    }

    /** Unlinks the user's Mac and drops any code still out. False when no Mac was linked. */
    forget(userId: string): boolean {
        const known = this.linked(userId) !== undefined;
        this.macs = this.macs.filter((mac) => mac.userId !== userId);
        this.pairings = this.pairings.filter((pairing) => pairing.userId !== userId);
        this.save();
        return known;
    }

    private save(): void {
        if (!this.file) return;
        const now = this.now().getTime();
        const offers = this.offers.filter((offer) => offer.expiresAt > now);
        const saved: Saved = { pairings: this.pairings, macs: this.macs, offers };
        mkdirSync(dirname(this.file), { recursive: true });
        const temporary = `${this.file}.tmp`;
        writeFileSync(temporary, JSON.stringify(saved, null, 2), { mode: 0o600 });
        renameSync(temporary, this.file);
    }
}
