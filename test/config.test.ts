import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, loadPhotonConfig } from "../src/config.js";

describe("loadConfig", () => {
    it("reads lines left empty in a copied .env.example as the defaults", () => {
        const config = loadConfig({
            CONSCIOUS_DATA_DIR: "",
            CONSCIOUS_PUBLIC_URL: "",
            CONSCIOUS_VAULT_PORT: "",
            CONSCIOUS_MODEL_BASE_URL: "",
            CONSCIOUS_MCP_SERVERS: "none",
        });

        expect(config.dataDir).toBe(join(process.cwd(), ".conscious"));
        expect(config.vault.publicUrl).toBe("http://localhost:8787");
        expect(config.model.baseUrl).toBeUndefined();
        expect(config.sandbox).toBeUndefined();
    });

    it("takes the Photon project from the SPECTRUM_ names the dashboard gives", () => {
        const photon = loadPhotonConfig({
            SPECTRUM_PROJECT_ID: "project",
            SPECTRUM_PROJECT_SECRET: "secret",
            CONSCIOUS_ALLOWED_USERS: "+39333",
        });

        expect(photon.projectId).toBe("project");
        expect(photon.projectSecret).toBe("secret");
    });

    it("stops at start on a key copied with masking dots", () => {
        expect(() => loadConfig({ ANTHROPIC_API_KEY: "sk-ant-u••••", CONSCIOUS_MCP_SERVERS: "none" })).toThrow(
            'ANTHROPIC_API_KEY has a "•" at position 9',
        );
    });
});
