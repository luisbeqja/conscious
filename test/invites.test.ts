import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inviteCommands } from "../src/invites/commands.js";
import { Invites } from "../src/invites/invites.js";

const day = 86_400_000;

describe("Invites", () => {
    it("lets the invited number in on WhatsApp at once, and on Telegram once its link is used", () => {
        const invites = new Invites();
        const invite = invites.create("+39444", "+39333");

        expect(invites.allows("+39444")).toBe(true);
        expect(invites.telegramUser("111")).toBeUndefined();
        expect(invites.claim(invite.code, "111")).toBe(true);
        expect(invites.claimedBy("111")?.userId).toBe("+39444");
        expect(invites.redeem(invite.code, "111")).toMatchObject({ userId: "+39444", telegramId: "111" });
        expect(invites.telegramUser("111")).toBe("+39444");
        // Once used, the link is spent.
        expect(invites.claim(invite.code, "222")).toBe(false);
    });

    it("stops a link after 7 days, and after /uninvite", () => {
        let now = new Date("2026-10-25T10:00:00Z");
        const invites = new Invites(undefined, () => now);
        const late = invites.create("+39444", "+39333");
        const revoked = invites.create("+39555", "+39333");

        now = new Date(now.getTime() + 7 * day + 1);
        expect(invites.claim(late.code, "111")).toBe(false);
        expect(invites.revoke("+39555")).toBe(true);
        expect(invites.claim(revoked.code, "222")).toBe(false);
        expect(invites.allows("+39555")).toBe(false);
        expect(invites.revoke("+39555")).toBe(false);
    });

    it("keeps invites and guests across a restart", () => {
        const file = join(mkdtempSync(join(tmpdir(), "invites-")), "invites.json");
        const before = new Invites(file);
        const invite = before.create("+39444", "+39333");
        before.claim(invite.code, "111");
        before.redeem(invite.code, "111");

        const after = new Invites(file);
        expect(after.allows("+39444")).toBe(true);
        expect(after.telegramUser("111")).toBe("+39444");
    });
});

const OWNER = "+393330000000";

describe("invite commands", () => {
    const setup = (telegram = true) => {
        const invites = new Invites();
        const command = inviteCommands({
            invites,
            isOwner: (userId) => userId === OWNER,
            telegramLink: telegram ? (code) => `https://t.me/conscious_bot?start=${code}` : undefined,
            whatsapp: true,
        });
        return { invites, command };
    };

    it("gives the owner a link for a number, in its own bubble", () => {
        const { invites, command } = setup();

        const reply = command(OWNER, "/invite +39 444 123 4567") ?? "";

        const code = invites.list()[0] && reply.match(/start=(inv-[a-z0-9]+)/)?.[1];
        expect(code).toMatch(/^inv-[a-z2-9]{10}$/);
        expect(reply.split("\n\n")).toContain(`https://t.me/conscious_bot?start=${code}`);
        expect(reply).toContain("WhatsApp from +394441234567");
        expect(invites.allows("+394441234567")).toBe(true);
    });

    it("lists the invited, takes access back, and leaves other text to the agent", () => {
        const { invites, command } = setup();
        command(OWNER, "/invite +39 444 123 4567");

        expect(command(OWNER, "/invites")).toContain("+394441234567: invited");
        expect(command(OWNER, "/uninvite +39 444 123 4567")).toContain("can no longer talk to Conscious");
        expect(invites.allows("+394441234567")).toBe(false);
        expect(command(OWNER, "invite my sister to dinner")).toBeUndefined();
    });

    it("asks for the country code, and lets only owners invite", () => {
        const { invites, command } = setup();

        expect(command(OWNER, "/invite 333 1234567")).toContain("country code");
        expect(command("+39444", "/invite +39 555 123 4567")).toBe(
            "Only the owner of this Conscious can invite people.",
        );
        expect(command(OWNER, "/invite +39 333 000 0000")).toContain("can already talk to Conscious");
        expect(invites.list()).toEqual([]);
    });

    it("still lets the number in on WhatsApp while the Telegram bot is not running", () => {
        const { command } = setup(false);
        expect(command(OWNER, "/invite +39 444 123 4567")).toBe(
            "Invite for +394441234567 ✅\n\n+394441234567 can text Conscious on WhatsApp now.",
        );
    });
});
