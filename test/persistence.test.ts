import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONNECTORS, type Connector } from "../src/plugins/connectors.js";
import type { PluginPackage } from "../src/plugins/manifest.js";
import { loadPluginFolder } from "../src/plugins/plugins.js";
import { PluginInstalls, PluginRegistry } from "../src/plugins/registry.js";
import { persistPlugins } from "../src/plugins/state-file.js";
import { loadOrCreateVaultKey, Vault } from "../src/vault/vault.js";

const [github] = loadPluginFolder(join(import.meta.dirname, "fixtures", "plugins"));
if (!github) throw new Error("plugins/github is missing");

/** One "process": a registry and installs backed by the file, with the bundled plugins seeded. */
const boot = (file: string, bundled: PluginPackage[] = [github]) => {
    const registry = new PluginRegistry();
    const installs = new PluginInstalls();
    persistPlugins(file, registry, installs);
    for (const pkg of bundled) registry.seed(pkg);
    return { registry, installs };
};

describe("surviving a restart", () => {
    it("keeps agent-written plugins, installs and disabled versions", () => {
        const file = join(mkdtempSync(join(tmpdir(), "plugins-")), "plugins.json");
        const first = boot(file);
        const mine: PluginPackage = { ...github, manifest: { ...github.manifest, id: "prs" } };
        mine.manifest.tools = mine.manifest.tools.map((tool) => ({
            ...tool,
            name: tool.name.replace("github_", "prs_"),
        }));
        const version = first.registry.publish(mine, { author: "me", source: "agent" });
        first.installs.add("me", { id: "prs", version: "1.1.0", hash: version.hash });
        first.registry.quarantine("github", "1.1.0", "test");

        const second = boot(file);
        expect(second.installs.list("me")).toEqual([{ id: "prs", version: "1.1.0", hash: version.hash }]);
        expect(second.registry.get("prs", "1.1.0")?.source).toBe("agent");
        expect(second.registry.search("prs", "me").map((listing) => listing.id)).toContain("prs");
        expect(second.registry.get("github", "1.1.0")?.quarantined).toBe("test");
    });

    it("takes the bundled copy when the repository changed it", () => {
        const file = join(mkdtempSync(join(tmpdir(), "plugins-")), "plugins.json");
        boot(file);
        const edited = { ...github, skill: `${github.skill}\n- Be brief.` };
        const { registry } = boot(file, [edited]);
        expect(registry.get("github", "1.1.0")?.pkg.skill).toContain("Be brief.");
        expect(registry.get("github", "1.1.0")?.source).toBe("bundled");
    });

    it("creates the Vault key once, owner-only, and opens saved accounts after a restart", async () => {
        const dir = mkdtempSync(join(tmpdir(), "data-"));
        const file = join(dir, "vault.json");
        new Vault({ key: loadOrCreateVaultKey(dir), file }).set(
            "me",
            CONNECTORS.get("github") as Connector,
            "ghp_example",
        );
        expect(statSync(join(dir, "vault.key")).mode & 0o777).toBe(0o600);
        const reopened = new Vault({ key: loadOrCreateVaultKey(dir), file });
        expect((await reopened.credential("me", "github"))?.token).toBe("ghp_example");
    });
});
