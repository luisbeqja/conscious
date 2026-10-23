import { ImapFlow } from "imapflow";
import { imapHost, type MailAccount } from "./account.js";

export interface MailSummary {
    uid: number;
    from?: string;
    to?: string;
    subject?: string;
    date?: string;
    unread: boolean;
    messageId?: string;
}

export interface MailQuery {
    text?: string;
    from?: string;
    since?: string;
    unread?: boolean;
}

/** What Conscious does in a mailbox. Nothing here sends, moves or deletes. */
export interface Mailbox {
    folders(): Promise<{ path: string; role?: string }[]>;
    search(folder: string, query: MailQuery, max: number): Promise<MailSummary[]>;
    /** The whole message as it is on the server. */
    source(folder: string, uid: number): Promise<Buffer | undefined>;
    /** Saves a message as a draft in the Drafts folder. */
    saveDraft(raw: string): Promise<{ folder: string }>;
    close(): Promise<void>;
}

export type OpenMailbox = (account: MailAccount) => Promise<Mailbox>;

const address = (list?: { name?: string; address?: string }[]) =>
    list?.map((entry) => (entry.name ? `${entry.name} <${entry.address}>` : entry.address)).join(", ");

/** Signs in over IMAPS (port 993). Fails at once when the server refuses the password. */
export const openImap: OpenMailbox = async (account) => {
    const client = new ImapFlow({
        host: imapHost(account),
        port: 993,
        secure: true,
        auth: { user: account.email, pass: account.password },
        logger: false,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 60_000,
    });
    await client.connect();
    const inFolder = async <T>(folder: string, run: () => Promise<T>): Promise<T> => {
        // Read-only, so opening a folder never marks anything as seen.
        const lock = await client.getMailboxLock(folder, { readOnly: true });
        try {
            return await run();
        } finally {
            lock.release();
        }
    };
    const folders = async () =>
        (await client.list()).map((entry) => ({ path: entry.path, role: entry.specialUse?.replace("\\", "") }));
    return {
        folders,
        search: (folder, query, max) =>
            inFolder(folder, async () => {
                const uids =
                    (await client.search(
                        {
                            ...(query.text ? { text: query.text } : {}),
                            ...(query.from ? { from: query.from } : {}),
                            ...(query.since ? { since: query.since } : {}),
                            ...(query.unread ? { seen: false } : {}),
                            ...(query.text || query.from || query.since || query.unread ? {} : { all: true }),
                        },
                        { uid: true },
                    )) || [];
                const newest = uids.sort((a, b) => b - a).slice(0, max);
                if (!newest.length) return [];
                const found = await client.fetchAll(newest, { envelope: true, flags: true }, { uid: true });
                return found
                    .map((message) => ({
                        uid: message.uid,
                        from: address(message.envelope?.from),
                        to: address(message.envelope?.to),
                        subject: message.envelope?.subject,
                        date: message.envelope?.date?.toISOString(),
                        unread: !message.flags?.has("\\Seen"),
                        messageId: message.envelope?.messageId,
                    }))
                    .sort((a, b) => b.uid - a.uid);
            }),
        source: (folder, uid) =>
            inFolder(folder, async () => {
                const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
                return message ? message.source : undefined;
            }),
        saveDraft: async (raw) => {
            const drafts = (await folders()).find((entry) => entry.role === "Drafts")?.path ?? "Drafts";
            await client.append(drafts, raw, ["\\Draft", "\\Seen"]);
            return { folder: drafts };
        },
        close: async () => {
            await client.logout().catch(() => client.close());
        },
    };
};
