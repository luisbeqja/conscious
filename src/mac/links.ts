import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** How long a pairing code works. */
const PAIRING_MINUTES = 15;

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

    /** Without a file, links live in this process only. */
    constructor(
        private readonly file?: string,
        private readonly now: () => Date = () => new Date(),
    ) {
        if (file && existsSync(file)) {
            const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<Saved>;
            this.pairings = saved.pairings ?? [];
            this.macs = saved.macs ?? [];
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
        const token = randomBytes(32).toString("base64url");
        this.macs = this.macs.filter((mac) => mac.userId !== pairing.userId);
        this.macs.push({
            userId: pairing.userId,
            name: name.trim().slice(0, 60) || "Mac",
            digest: digestOf(token).toString("hex"),
            pairedAt: now.toISOString(),
        });
        this.save();
        return { userId: pairing.userId, token };
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
        const saved: Saved = { pairings: this.pairings, macs: this.macs };
        mkdirSync(dirname(this.file), { recursive: true });
        const temporary = `${this.file}.tmp`;
        writeFileSync(temporary, JSON.stringify(saved, null, 2), { mode: 0o600 });
        renameSync(temporary, this.file);
    }
}
