import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

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
});
