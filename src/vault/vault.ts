import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONNECTORS, type Connector, type Credential, type Credentials } from "../plugins/connectors.js";

const LINK_TTL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

export interface VaultLink {
    code: string;
    userId: string;
    /** As it was when the link was made: these are the hosts the user approves on the page. */
    connector: Connector;
    expiresAt: Date;
    attempts: number;
}

interface Sealed {
    iv: string;
    tag: string;
    data: string;
}

/** One saved account: the sealed token and what the user approved it for. */
interface Entry {
    sealed: Sealed;
    name: string;
    hosts: string[];
    header?: string;
}

/** Entries saved before approvals were stored are bare sealed tokens for a built-in connector. */
const upgrade = (slotKey: string, saved: Entry | Sealed): Entry | undefined => {
    if ("sealed" in saved) return saved;
    const connector = CONNECTORS.get(slotKey.split("\n")[1] ?? "");
    return connector && { sealed: saved, name: connector.name, hosts: [...connector.hosts] };
};

export interface VaultOptions {
    /** 32 bytes. Without one, a random key lives in memory and nothing is saved. */
    key?: Buffer;
    /** Where sealed secrets are saved. Only used with a key, so a restart can open them again. */
    file?: string;
}

/** The key from the environment, or one created on first start and kept beside the data (owner-only). */
export const loadOrCreateVaultKey = (dataDir: string, fromEnv?: Buffer): Buffer => {
    if (fromEnv) return fromEnv;
    const file = join(dataDir, "vault.key");
    if (existsSync(file)) return Buffer.from(readFileSync(file, "utf8").trim(), "base64");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    writeFileSync(file, key.toString("base64"), { mode: 0o600, flag: "wx" });
    return key;
};

/**
 * Where users' secrets live. They arrive through the Vault page, never through the chat, and
 * leave only to the broker, which adds them to a plugin's requests. The model sees which
 * accounts are connected, never a secret. Secrets are sealed with AES-256-GCM.
 */
export class Vault implements Credentials {
    private readonly key: Buffer;
    private readonly file?: string;
    private readonly secrets = new Map<string, Entry>();
    private readonly links = new Map<string, VaultLink>();

    constructor(options: VaultOptions = {}) {
        if (options.key && options.key.length !== 32) throw new Error("CONSCIOUS_VAULT_KEY must be 32 bytes, base64");
        this.key = options.key ?? randomBytes(32);
        this.file = options.key ? options.file : undefined;
        if (this.file && existsSync(this.file)) {
            const saved = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Entry | Sealed>;
            for (const [slotKey, value] of Object.entries(saved)) {
                const entry = upgrade(slotKey, value);
                if (entry) this.secrets.set(slotKey, entry);
            }
            // Fails now, at start, if the key does not match the file.
            for (const entry of this.secrets.values()) this.open(entry.sealed);
        }
    }

    async credential(userId: string, connector: string): Promise<Credential | undefined> {
        const entry = this.secrets.get(slot(userId, connector));
        return entry && { token: this.open(entry.sealed), hosts: entry.hosts, header: entry.header };
    }

    /** Saves a token for exactly the connector the user saw: its hosts are the approval. */
    set(userId: string, connector: Connector, secret: string): void {
        this.secrets.set(slot(userId, connector.id), {
            sealed: this.seal(secret),
            name: connector.name,
            hosts: [...connector.hosts],
            header: connector.header,
        });
        this.persist();
    }

    remove(userId: string, connector: string): boolean {
        const removed = this.secrets.delete(slot(userId, connector));
        if (removed) this.persist();
        return removed;
    }

    connected(userId: string): Array<{ id: string; name: string; hosts: string[] }> {
        const prefix = `${userId}\n`;
        return [...this.secrets]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, entry]) => ({ id: key.slice(prefix.length), name: entry.name, hosts: entry.hosts }));
    }

    /** A single-use link to the Vault page. The code is the only thing that grants access. */
    createLink(userId: string, connector: Connector, now = new Date()): VaultLink {
        this.dropExpired(now);
        const link: VaultLink = {
            code: randomBytes(24).toString("base64url"),
            userId,
            connector,
            expiresAt: new Date(now.getTime() + LINK_TTL_MS),
            attempts: 0,
        };
        this.links.set(link.code, link);
        return link;
    }

    findLink(code: string, now = new Date()): VaultLink | undefined {
        const link = this.links.get(code);
        if (!link) return undefined;
        if (link.expiresAt <= now || link.attempts >= MAX_ATTEMPTS) {
            this.links.delete(code);
            return undefined;
        }
        return link;
    }

    /** A rejected secret counts against the link, so it cannot be used to guess. */
    failAttempt(code: string): void {
        const link = this.links.get(code);
        if (link) link.attempts++;
    }

    consumeLink(code: string): void {
        this.links.delete(code);
    }

    private dropExpired(now: Date): void {
        for (const [code, link] of this.links) if (link.expiresAt <= now) this.links.delete(code);
    }

    private seal(secret: string): Sealed {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, iv);
        const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
        return {
            iv: iv.toString("base64"),
            tag: cipher.getAuthTag().toString("base64"),
            data: data.toString("base64"),
        };
    }

    private open(sealed: Sealed): string {
        const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(sealed.iv, "base64"));
        decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
    }

    private persist(): void {
        if (!this.file) return;
        mkdirSync(dirname(this.file), { recursive: true });
        const temporary = `${this.file}.tmp`;
        writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.secrets)), { mode: 0o600 });
        renameSync(temporary, this.file);
    }
}

const slot = (userId: string, connector: string) => `${userId}\n${connector}`;
