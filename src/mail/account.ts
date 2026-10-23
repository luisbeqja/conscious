import type { Connector } from "../plugins/connectors.js";

/** One mailbox, as the user saved it on the Vault page. */
export interface MailAccount {
    email: string;
    password: string;
    /** The IMAP server, when the address's provider is not one Conscious knows. */
    host?: string;
}

export const MAIL_CONNECTOR: Connector = {
    id: "mail",
    name: "your mailbox",
    hosts: [],
    howTo: {
        url: "https://support.apple.com/en-us/102654",
        steps: [
            "Most providers want an app password, not your normal one: iCloud (appleid.apple.com, Sign-In and Security), Gmail (myaccount.google.com/apppasswords), Yahoo, Fastmail. GMX, WEB.DE, Libero and Posteo take your normal password once IMAP is on in their settings.",
            "Type your email address and that password below.",
            "Conscious reads mail and saves drafts. It never sends or deletes anything.",
        ],
    },
    verifyUrl: "imap:",
    fields: [
        { name: "email", label: "Email address", type: "email" },
        { name: "password", label: "App password", type: "password" },
        {
            name: "host",
            label: "IMAP server (only if Conscious asks)",
            type: "text",
            optional: true,
            hint: "For example imap.example.com. Leave empty for iCloud, Gmail, Yahoo, GMX, WEB.DE, Libero, Posteo, Fastmail and most others.",
        },
    ],
};

/** IMAP servers by address domain, for providers whose server is not simply imap.<domain>. */
const SERVERS: Record<string, string> = {
    "gmail.com": "imap.gmail.com",
    "googlemail.com": "imap.gmail.com",
    "icloud.com": "imap.mail.me.com",
    "me.com": "imap.mail.me.com",
    "mac.com": "imap.mail.me.com",
    "outlook.com": "outlook.office365.com",
    "hotmail.com": "outlook.office365.com",
    "live.com": "outlook.office365.com",
    "msn.com": "outlook.office365.com",
    "yahoo.com": "imap.mail.yahoo.com",
    "gmx.de": "imap.gmx.net",
    "gmx.net": "imap.gmx.net",
    "gmx.at": "imap.gmx.net",
    "gmx.ch": "imap.gmx.net",
    "gmx.com": "imap.gmx.com",
    "web.de": "imap.web.de",
    "libero.it": "imapmail.libero.it",
    "virgilio.it": "in.virgilio.it",
    "tiscali.it": "imap.tiscali.it",
    "posteo.de": "posteo.de",
    "posteo.net": "posteo.de",
    "mailbox.org": "imap.mailbox.org",
    "fastmail.com": "imap.fastmail.com",
    "t-online.de": "secureimap.t-online.de",
    "orange.fr": "imap.orange.fr",
    "free.fr": "imap.free.fr",
    "laposte.net": "imap.laposte.net",
    "seznam.cz": "imap.seznam.cz",
    "wp.pl": "imap.wp.pl",
    "o2.pl": "poczta.o2.pl",
    "interia.pl": "poczta.interia.pl",
};

export const imapHost = (account: MailAccount): string => {
    if (account.host) return account.host.replace(/^imaps?:\/\//, "").replace(/[:/].*$/, "");
    const domain = account.email.split("@")[1]?.toLowerCase() ?? "";
    return SERVERS[domain] ?? `imap.${domain}`;
};

export const parseAccount = (secret: string): MailAccount => {
    const parsed = JSON.parse(secret) as Partial<MailAccount>;
    if (!parsed.email?.includes("@") || !parsed.password) throw new Error("The saved mailbox is incomplete");
    return { email: parsed.email, password: parsed.password, host: parsed.host };
};
