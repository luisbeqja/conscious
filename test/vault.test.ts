import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVaultCapability } from "../src/capabilities/vault/capability.js";
import { CONNECTORS, type Connector } from "../src/plugins/connectors.js";
import { createVaultServer } from "../src/vault/server.js";
import { Vault } from "../src/vault/vault.js";

const github = CONNECTORS.get("github") as Connector;
const token = async (vault: Vault, connector = "github") => (await vault.credential("me", connector))?.token;

describe("Vault", () => {
    it("keeps secrets sealed on disk and opens them after a restart with the same key", async () => {
        const file = join(mkdtempSync(join(tmpdir(), "vault-")), "vault.json");
        const key = randomBytes(32);
        new Vault({ key, file }).set("me", github, "ghp_example");

        const { readFileSync } = await import("node:fs");
        expect(readFileSync(file, "utf8")).not.toContain("ghp_example");
        expect(await token(new Vault({ key, file }))).toBe("ghp_example");
        expect(() => new Vault({ key: randomBytes(32), file })).toThrow();
    });

    it("issues links that expire and stop after too many wrong tokens", () => {
        const vault = new Vault();
        const now = new Date("2026-10-12T10:00:00Z");
        const link = vault.createLink("me", github, now);
        expect(vault.findLink(link.code, now)?.userId).toBe("me");
        expect(vault.findLink(link.code, new Date("2026-10-12T10:16:00Z"))).toBeUndefined();

        const other = vault.createLink("me", github, now);
        for (let attempt = 0; attempt < 5; attempt++) vault.failAttempt(other.code);
        expect(vault.findLink(other.code, now)).toBeUndefined();
    });

    it("gives the agent a link, never a secret", async () => {
        const vault = new Vault();
        vault.set("me", github, "ghp_example");
        const capability = createVaultCapability(vault, "https://conscious.example.com/");
        const context = { userId: "me", timezone: "Europe/Rome", scheduler: undefined as never };
        const [request, list] = capability.tools;
        const link = await request?.execute({ connector: "github" }, context);
        expect(JSON.stringify(link)).toMatch(/^.*"url":"https:\/\/conscious\.example\.com\/vault\/[\w-]{32}".*$/);
        const listed = await list?.execute({}, context);
        expect(JSON.stringify(listed)).not.toContain("ghp_example");
        expect(listed?.data).toContainEqual({ connector: "github", name: "GitHub", connected: true });
    });
});

describe("accounts not set up on this install", () => {
    it("tells the agent what the owner must do, instead of listing only what works", async () => {
        const capability = createVaultCapability(new Vault(), "https://c.example", () => [github], [
            { id: "google", name: "Google", setup: "set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env." },
        ]);
        const context = { userId: "me", timezone: "Europe/Rome", scheduler: undefined as never };
        const [request, list] = capability.tools;
        const listed = await list?.execute({}, context);
        expect(listed?.data).toContainEqual({
            connector: "google",
            name: "Google",
            connected: false,
            setUpOnThisInstall: false,
        });
        const asked = await request?.execute({ connector: "google" }, context);
        expect(JSON.stringify(asked?.data)).not.toContain("/vault/");
        expect(asked?.guidance).toMatch(/GOOGLE_CLIENT_ID/);
        expect(asked?.guidance).toMatch(/whoever runs Conscious/);
    });
});

describe("Vault page", () => {
    let close = () => {};
    afterEach(() => close());

    const serve = (accepted: string) => {
        const vault = new Vault();
        const connected: string[] = [];
        const server = createVaultServer({
            vault,
            verify: async (_connector, secret) => secret === accepted,
            onConnected: async (userId, connector) => {
                connected.push(`${userId}:${connector.id}`);
            },
        }).listen(0);
        close = () => server.close();
        const base = `http://localhost:${(server.address() as AddressInfo).port}`;
        const post = (code: string, secret: string) =>
            fetch(`${base}/vault/${code}`, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ secret }),
            });
        return { vault, connected, base, post };
    };

    it("saves a working token once, tells the user, and retires the link", async () => {
        const { vault, connected, base, post } = serve("ghp_good");
        const { code } = vault.createLink("me", github);

        const form = await fetch(`${base}/vault/${code}`);
        expect(form.status).toBe(200);
        expect(form.headers.get("content-security-policy")).toContain("default-src 'none'");
        expect(await form.text()).toContain("Connect GitHub");

        const wrong = await post(code, "ghp_bad");
        expect(wrong.status).toBe(400);
        expect(await token(vault)).toBeUndefined();

        expect((await post(code, " ghp_good ")).status).toBe(200);
        expect(await token(vault)).toBe("ghp_good");
        expect(connected).toEqual(["me:github"]);
        expect((await fetch(`${base}/vault/${code}`)).status).toBe(410);
    });

    it("shows nothing for an unknown link", async () => {
        const { base } = serve("x");
        expect((await fetch(`${base}/vault/${"a".repeat(32)}`)).status).toBe(410);
        expect((await fetch(`${base}/`)).status).toBe(404);
    });
});
