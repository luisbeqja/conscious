/**
 * Signing in with SPID from a phone, when the browser is on another computer. An identity
 * provider's page in a desktop browser shows a QR code for its app; the person texting Conscious
 * has only their phone, so they cannot scan it. The same sign-in can be approved through a link
 * that opens the provider's app: the page keeps waiting for that transaction and goes on by itself
 * once the user approves it.
 */

/** What the provider's page in the browser is waiting for, read from the page. */
export interface SpidTransaction {
    /** The page's address host, which says whose page it is. */
    host: string;
    /** The transaction the page polls for, the same one its QR code carries. */
    id: string;
    /** How long the code lasts from when the page made it, in seconds. */
    lifetimeSeconds?: number;
}

/** A link that opens the provider's app on the user's phone, on this sign-in. */
export interface AppApproval {
    provider: string;
    app: string;
    link: string;
    lifetimeSeconds: number;
}

interface Provider {
    name: string;
    app: string;
    hosts: RegExp;
    link: (id: string) => string;
    lifetimeSeconds: number;
}

// Each provider is added once its app link has been checked against its own page's script.
const PROVIDERS: Provider[] = [
    {
        // posteid.poste.it's login.jsp: buildDeepLink(…, "https://appregistry-posteid.mobile.poste.it/…?tranId=")
        // with the page's `shtrans`, polled at /jod-login-schema/polling/v4/app.
        name: "Poste ID",
        app: "PosteID",
        hosts: /(^|\.)posteid\.poste\.it$/,
        link: (id) =>
            `https://appregistry-posteid.mobile.poste.it/jod-login-schema/btcs/pid/access/v1/?tranId=${encodeURIComponent(id)}`,
        lifetimeSeconds: 120,
    },
];

/** The providers whose app can approve a sign-in started in Conscious's browser. */
export const appProviders = (): string[] => PROVIDERS.map((provider) => provider.name);

/** The link to the provider's app for this transaction, or undefined for a provider not known. */
export const appApproval = (transaction: SpidTransaction): AppApproval | undefined => {
    const provider = PROVIDERS.find((candidate) => candidate.hosts.test(transaction.host.toLowerCase()));
    if (!provider || !/^[\w-]{8,128}$/.test(transaction.id)) return undefined;
    return {
        provider: provider.name,
        app: provider.app,
        link: provider.link(transaction.id),
        lifetimeSeconds: transaction.lifetimeSeconds ?? provider.lifetimeSeconds,
    };
};
