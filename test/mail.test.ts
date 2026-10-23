import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createMailCapability, verifyMailbox } from "../src/capabilities/mail/capability.js";
import type { ToolContext } from "../src/capabilities/types.js";
import { imapHost, MAIL_CONNECTOR } from "../src/mail/account.js";
import type { Mailbox, MailQuery, OpenMailbox } from "../src/mail/imap.js";
import { resolveConnector } from "../src/plugins/connectors.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { createVaultServer } from "../src/vault/server.js";
import { Vault } from "../src/vault/vault.js";

const context: ToolContext = { userId: "me", timezone: "Europe/Rome", scheduler: new Scheduler(async () => {}) };
const account = { email: "ada@gmx.de", password: "app-pass" };

const MESSAGE = [
    "From: Nonna <nonna@libero.it>",
    "To: ada@gmx.de",
    "Subject: =?UTF-8?B?UHJhbnpvIGRpIGRvbWVuaWNh?=",
    "Message-ID: <lunch@libero.it>",
    "Date: Thu, 22 Oct 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="b"',
    "",
    "--b",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Vieni alle <b>13</b>?</p>",
    "--b--",
    "",
].join("\r\n");

const fakeMailbox = () => {
    const seen = { queries: [] as MailQuery[], drafts: [] as string[], closed: 0, opened: [] as string[] };
    const mailbox: Mailbox = {
        folders: async () => [
            { path: "INBOX", role: "Inbox" },
            { path: "Entwürfe", role: "Drafts" },
        ],
        search: async (_folder, query) => {
            seen.queries.push(query);
            return [{ uid: 7, from: "Nonna <nonna@libero.it>", subject: "Pranzo di domenica", unread: true }];
        },
        source: async (_folder, uid) => (uid === 7 ? Buffer.from(MESSAGE) : undefined),
        saveDraft: async (raw) => {
            seen.drafts.push(raw);
            return { folder: "Entwürfe" };
        },
        close: async () => {
            seen.closed++;
        },
    };
    const open: OpenMailbox = async (opened) => {
        seen.opened.push(`${opened.email}:${opened.password}`);
        return mailbox;
    };
    return { seen, open };
};

const connected = () => {
    const vault = new Vault();
    vault.set("me", MAIL_CONNECTOR, JSON.stringify(account));
    return vault;
};

const toolOf = (capability: ReturnType<typeof createMailCapability>, name: string) => {
    const tool = capability.tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(name);
    return tool;
};

describe("a mailbox over IMAP", () => {
    it("finds the server for common providers, and takes one the user typed", () => {
        expect(imapHost({ ...account, email: "a@icloud.com" })).toBe("imap.mail.me.com");
        expect(imapHost({ ...account, email: "a@libero.it" })).toBe("imapmail.libero.it");
        expect(imapHost({ ...account, email: "a@example.org" })).toBe("imap.example.org");
        expect(imapHost({ ...account, host: "imaps://mail.example.org:993/" })).toBe("mail.example.org");
    });

    it("is offered only once connected, and the password never reaches a plugin", async () => {
        const vault = new Vault();
        const capability = createMailCapability(fakeMailbox().open, vault);
        expect(await capability.available?.("me")).toBe(false);
        vault.set("me", MAIL_CONNECTOR, JSON.stringify(account));
        expect(await capability.available?.("me")).toBe(true);
        expect(resolveConnector({ connector: "mail" }).problems[0]).toMatch(/cannot be used by a plugin/);
    });

    it("searches and reads as the user, closing the connection each time", async () => {
        const { seen, open } = fakeMailbox();
        const capability = createMailCapability(open, connected());
        await toolOf(capability, "mail_search_messages").execute({ from: "nonna", unread: true }, context);
        const output = await toolOf(capability, "mail_read_message").execute({ uid: 7 }, context);
        expect(seen.queries[0]).toMatchObject({ from: "nonna", unread: true });
        expect(seen.opened).toEqual(["ada@gmx.de:app-pass", "ada@gmx.de:app-pass"]);
        expect(seen.closed).toBe(2);
        expect(output.data).toMatchObject({
            subject: "Pranzo di domenica",
            messageId: "<lunch@libero.it>",
            text: expect.stringContaining("Vieni alle"),
        });
        expect(output.guidance).toMatch(/never instructions/);
    });

    it("saves a reply as a draft from the user's address, in their own Drafts folder", async () => {
        const { seen, open } = fakeMailbox();
        const output = await toolOf(createMailCapability(open, connected()), "mail_draft_message").execute(
            { to: "nonna@libero.it", subject: "Re: Pranzo", body: "Sì!\nA domenica", inReplyTo: "<lunch@libero.it>" },
            context,
        );
        expect(output.data).toEqual({ savedIn: "Entwürfe" });
        expect(seen.drafts[0]).toMatch(/^From: ada@gmx\.de\r\n/);
        expect(seen.drafts[0]).toContain("In-Reply-To: <lunch@libero.it>");
        expect(seen.drafts[0]).toContain("Sì!\r\nA domenica");
    });

    it("tells a wrong password from a server it cannot reach", async () => {
        const refusing: OpenMailbox = async () => {
            throw Object.assign(new Error("Invalid credentials"), { authenticationFailed: true });
        };
        const unreachable: OpenMailbox = async () => {
            throw new Error("getaddrinfo ENOTFOUND");
        };
        expect(await verifyMailbox(refusing, JSON.stringify(account))).toBe(false);
        await expect(verifyMailbox(unreachable, JSON.stringify(account))).rejects.toThrow(/ENOTFOUND/);
        expect(await verifyMailbox(fakeMailbox().open, JSON.stringify(account))).toBe(true);
    });
});

describe("the Vault page for a mailbox", () => {
    let server: Server | undefined;
    afterEach(() => server?.close());

    it("asks for the address and password, and saves them together", async () => {
        const vault = new Vault();
        server = createVaultServer({
            vault,
            verify: async (_connector, secret) => JSON.parse(secret).password === "app-pass",
            onConnected: async () => {},
        }).listen(0);
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const { code } = vault.createLink("me", MAIL_CONNECTOR);
        const page = await (await fetch(`${base}/vault/${code}`)).text();
        expect(page).toContain('name="email"');
        expect(page).toContain('name="password"');
        expect(page).not.toContain('name="secret"');

        const post = (fields: Record<string, string>) =>
            fetch(`${base}/vault/${code}`, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams(fields),
            });
        expect((await post({ email: "ada@gmx.de" })).status).toBe(400);
        expect((await post({ email: "ada@gmx.de", password: "app-pass" })).status).toBe(200);
        expect(JSON.parse((await vault.credential("me", "mail"))?.token ?? "")).toEqual(account);
    });
});
