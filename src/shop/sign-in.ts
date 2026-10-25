import type { Connector } from "../plugins/connectors.js";
import type { DeviceSignInProvider } from "../vault/server.js";
import type { Vault } from "../vault/vault.js";

const ACCOUNTS = "https://accounts.shop.app";
/** Shop's public client for a shopper's own agent, the one its CLI signs in with. It has no secret. */
const CLIENT_ID = "5c733ab2-1903-400a-891e-7ba20c09e2a3";
const RESOURCE = "https://mcp.shop.com";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** As long as a Vault link: the user approves within it or starts again. */
const MAX_WAIT_MS = 15 * 60_000;
/** Codes waited for at once per user, so pressing the button again does not lose the first. */
const MAX_WAITS = 3;

export const SHOP_CONNECTOR: Connector = {
    id: "shop",
    name: "Shop",
    hosts: ["accounts.shop.app", "mcp.shop.com"],
    howTo: {
        url: "https://shop.com/",
        steps: [
            "Press Sign in with Shop, then sign in to your Shop account, or make one.",
            "Approve Conscious. It can then see your saved addresses and track your orders.",
            "You can remove it any time in your Shop account, or by asking Conscious.",
        ],
    },
    verifyUrl: "https://mcp.shop.com/",
    signIn: "Shop",
};

/** What the Vault keeps for a user's Shop sign-in. */
interface SavedSignIn {
    access_token: string;
    refresh_token?: string;
    /** Epoch ms. */
    expires_at?: number;
}

interface TokenAnswer {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
}

interface DeviceAnswer {
    device_code?: string;
    user_code?: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
}

const pause = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });

const kept = (answer: TokenAnswer, refreshToken?: string): SavedSignIn => ({
    access_token: answer.access_token as string,
    // A refresh that sends no new refresh token keeps the old one.
    refresh_token: answer.refresh_token ?? refreshToken,
    expires_at: answer.expires_in ? Date.now() + answer.expires_in * 1000 : undefined,
});

/**
 * The user's Shop account, signed in with the OAuth device flow Shop offers a shopper's own agent,
 * so nobody registers an app. The Vault page shows the code and sends the user to Shop's page;
 * Conscious asks Shop until they approve, and keeps the tokens in the Vault.
 */
export class ShopSignIn implements DeviceSignInProvider {
    private readonly waits = new Map<string, AbortController[]>();
    private readonly refreshing = new Map<string, Promise<string | undefined>>();

    constructor(
        private readonly vault: Pick<Vault, "credential" | "set" | "remove">,
        private readonly doFetch: typeof fetch = fetch,
        private readonly wait: (ms: number, signal: AbortSignal) => Promise<void> = pause,
    ) {}

    async start(userId: string) {
        const device = (await this.post("/oauth/device", {
            client_id: CLIENT_ID,
            resource: RESOURCE,
            scope: "openid email personal_agent",
            // How the connection is named in the user's Shop account.
            device_name: "Conscious",
        })) as DeviceAnswer;
        if (!device.device_code || !device.user_code || !device.verification_uri_complete) {
            throw new Error("Shop did not start the sign-in");
        }
        // The user may approve an earlier code than the newest, so a few are waited for at once.
        const controller = new AbortController();
        const waiting = [...(this.waits.get(userId) ?? []), controller];
        while (waiting.length > MAX_WAITS) waiting.shift()?.abort();
        this.waits.set(userId, waiting);
        const approved = this.poll(device, controller.signal)
            .then((secret) => {
                // Signed in: the other codes are not needed any more.
                if (secret) for (const other of this.waits.get(userId) ?? []) other.abort();
                return secret;
            })
            .finally(() => {
                const left = (this.waits.get(userId) ?? []).filter((other) => other !== controller);
                if (left.length) this.waits.set(userId, left);
                else this.waits.delete(userId);
            });
        return { url: device.verification_uri_complete, userCode: device.user_code, approved };
    }

    async connected(userId: string): Promise<boolean> {
        return Boolean(await this.vault.credential(userId, SHOP_CONNECTOR.id));
    }

    /** The user's access token, refreshed when it is about to expire. Undefined when Shop is not connected. */
    async accessToken(userId: string, force = false): Promise<string | undefined> {
        const credential = await this.vault.credential(userId, SHOP_CONNECTOR.id);
        if (!credential) return undefined;
        const signIn = JSON.parse(credential.token) as SavedSignIn;
        if (!force && (!signIn.expires_at || signIn.expires_at > Date.now() + 60_000)) return signIn.access_token;
        // A refresh token may be single-use, so two calls at once share one refresh.
        let running = this.refreshing.get(userId);
        if (!running) {
            running = this.refresh(userId, signIn).finally(() => this.refreshing.delete(userId));
            this.refreshing.set(userId, running);
        }
        return running;
    }

    /** Drops a sign-in Shop refused, so the agent offers a new one. */
    forget(userId: string): void {
        this.vault.remove(userId, SHOP_CONNECTOR.id);
    }

    private async poll(device: DeviceAnswer, signal: AbortSignal): Promise<string | undefined> {
        let interval = (device.interval ?? 5) * 1000;
        const deadline = Date.now() + Math.min((device.expires_in ?? 900) * 1000, MAX_WAIT_MS);
        while (Date.now() < deadline) {
            await this.wait(interval, signal);
            if (signal.aborted) return undefined;
            const answer = await this.post("/oauth/token", {
                grant_type: DEVICE_GRANT,
                client_id: CLIENT_ID,
                device_code: device.device_code as string,
            }).catch((): TokenAnswer => ({ error: "authorization_pending" }));
            if (answer.access_token) return JSON.stringify(kept(answer));
            if (answer.error === "slow_down") interval += 5_000;
            // Declined, expired, or refused: the user asks for a new link.
            else if (answer.error !== "authorization_pending") return undefined;
        }
        return undefined;
    }

    private async refresh(userId: string, signIn: SavedSignIn): Promise<string | undefined> {
        if (!signIn.refresh_token) {
            this.forget(userId);
            return undefined;
        }
        const answer = await this.post("/oauth/token", {
            grant_type: "refresh_token",
            refresh_token: signIn.refresh_token,
            client_id: CLIENT_ID,
        });
        if (!answer.access_token) {
            if (answer.error !== "invalid_grant") throw new Error(`Shop could not renew the sign-in: ${answer.error}`);
            this.forget(userId);
            return undefined;
        }
        this.vault.set(userId, SHOP_CONNECTOR, JSON.stringify(kept(answer, signIn.refresh_token)));
        return answer.access_token;
    }

    private async post(path: string, params: Record<string, string>): Promise<TokenAnswer> {
        const response = await this.doFetch(`${ACCOUNTS}${path}`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: new URLSearchParams(params).toString(),
            signal: AbortSignal.timeout(30_000),
        });
        return (await response.json().catch(() => ({ error: `HTTP ${response.status}` }))) as TokenAnswer;
    }
}
