/**
 * The accounts a plugin can act as. A connector's hosts are the only places its token is ever
 * sent, and a plugin that uses one may not call anything else, so it cannot carry what it
 * reads with the token somewhere else.
 *
 * Built-in connectors ship with Conscious. Any other connector is defined by the plugin that
 * uses it, usually written by an agent; the user approves its hosts on the Vault page.
 */
export interface Connector {
    id: string;
    name: string;
    hosts: readonly string[];
    /** Shown on the Vault page: where the user gets the secret, step by step. */
    howTo: { url: string; steps: readonly string[] };
    /** A GET that succeeds only with a working token, checked before the Vault saves it. */
    verifyUrl: string;
    /** The header the token goes in, as is. Without it: `Authorization: Bearer <token>`. */
    header?: string;
    /** Written in a plugin, not shipped with Conscious: nobody but the user checked it. */
    agentDefined?: boolean;
    /** Connected by signing in on this provider's own page instead of pasting a token, e.g. "Google". */
    signIn?: string;
    /** Several values instead of one token, saved together as JSON. Only Conscious's own connectors. */
    fields?: readonly ConnectorField[];
}

export interface ConnectorField {
    name: string;
    label: string;
    type: "text" | "email" | "password";
    optional?: boolean;
    hint?: string;
}

export const CONNECTORS: ReadonlyMap<string, Connector> = new Map(
    [
        {
            id: "github",
            name: "GitHub",
            hosts: ["api.github.com"],
            howTo: {
                url: "https://github.com/settings/tokens/new?scopes=notifications,repo&description=Conscious",
                steps: [
                    "Open the link and sign in to GitHub.",
                    "Keep the scopes it ticked for you: notifications and repo. Pick an expiry.",
                    "Press Generate token, copy it, and paste it below.",
                ],
            },
            verifyUrl: "https://api.github.com/user",
        },
    ].map((connector) => [connector.id, connector]),
);

/** A saved token and the hosts the user approved for it, when they saved it. */
export interface Credential {
    token: string;
    hosts: readonly string[];
    header?: string;
}

/** Where a user's tokens live. Tokens never reach the model or plugin code. */
export interface Credentials {
    credential(userId: string, connector: string): Promise<Credential | undefined>;
}

export class InMemoryCredentials implements Credentials {
    private readonly saved = new Map<string, Credential>();

    set(userId: string, connector: string, credential: Credential): this {
        this.saved.set(`${userId}:${connector}`, credential);
        return this;
    }

    async credential(userId: string, connector: string): Promise<Credential | undefined> {
        return this.saved.get(`${userId}:${connector}`);
    }
}

export const authHeader = (token: string, header?: string): Record<string, string> =>
    header ? { [header]: token } : { authorization: `Bearer ${token}` };

/** What the agent does when a plugin needs an account the user has not connected. */
export const notConnectedGuidance = (connector: Connector): string =>
    `The user's ${connector.name} account is not connected. Call vault_request_connection with connector "${connector.id}" and send them the link. Never ask them to paste the token in the chat.`;

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IP_LIKE = /^[\d.]+$|:/;

/** Public DNS names only: no IPs, no localhost, nothing that reaches our own network. */
export const hostProblems = (field: string, hosts: readonly string[]): string[] =>
    hosts
        .filter((host) => !HOSTNAME.test(host) || IP_LIKE.test(host) || /\.(local|internal|localhost)$/.test(host))
        .map((host) => `${field}: "${host}" is not a public hostname`);

/** Headers a token may never be put in: they would change what the request is, not who sends it. */
const RESERVED_HEADERS = new Set(["cookie", "host", "content-type", "content-length", "transfer-encoding"]);

export interface ConnectorSpec {
    connector: string;
    name?: string;
    hosts?: string[];
    howTo?: { url: string; steps: string[] };
    verifyUrl?: string;
    header?: string;
}

/**
 * Accounts Conscious connects itself, by sign-in or its own form. What the Vault keeps for them
 * (a refresh token, a mailbox password) is never handed to a plugin. Sign-in MCP servers are
 * `mcp-<name>`, which a plugin's connector id cannot spell.
 */
const HOST_ONLY_IDS = new Set(["google", "spotify", "mail"]);

/** The connector a plugin uses: a built-in one by id, or the one it defines itself. */
export const resolveConnector = (spec: ConnectorSpec): { connector?: Connector; problems: string[] } => {
    if (HOST_ONLY_IDS.has(spec.connector)) {
        return { problems: [`auth: "${spec.connector}" is built into Conscious and cannot be used by a plugin`] };
    }
    const builtIn = CONNECTORS.get(spec.connector);
    const defines = spec.name ?? spec.hosts ?? spec.howTo ?? spec.verifyUrl ?? spec.header;
    if (builtIn) {
        if (defines !== undefined) {
            return { problems: [`auth: "${spec.connector}" is built in; give only its id (and scopes)`] };
        }
        return { connector: builtIn, problems: [] };
    }
    const { name, hosts, howTo, verifyUrl, header } = spec;
    if (!name || !hosts?.length || !howTo || !verifyUrl) {
        return {
            problems: [
                `auth: "${spec.connector}" is not built in (built in: ${[...CONNECTORS.keys()].join(", ")}), so define it: name, hosts, howTo, verifyUrl, and header if the token is not a Bearer token`,
            ],
        };
    }
    const problems = hostProblems("auth.hosts", hosts);
    const verify = URL.canParse(verifyUrl) ? new URL(verifyUrl) : undefined;
    if (verify?.protocol !== "https:" || !hosts.includes(verify.hostname)) {
        problems.push("auth.verifyUrl: must be an https URL on one of the connector's hosts");
    }
    if (!URL.canParse(howTo.url) || new URL(howTo.url).protocol !== "https:") {
        problems.push("auth.howTo.url: must be an https URL");
    }
    if (header !== undefined && (!/^[a-z][a-z0-9-]{1,40}$/.test(header) || RESERVED_HEADERS.has(header))) {
        problems.push(`auth.header: "${header}" is not a header a token can go in (lowercase, e.g. x-api-key)`);
    }
    if (problems.length) return { problems };
    return {
        connector: { id: spec.connector, name, hosts, howTo, verifyUrl, header, agentDefined: true },
        problems: [],
    };
};
