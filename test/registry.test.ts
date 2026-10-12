import { describe, expect, it } from "vitest";
import { createRegistry } from "../src/capabilities/index.js";
import { CapabilityRegistry } from "../src/capabilities/registry.js";

describe("CapabilityRegistry", () => {
    it("offers a capability only to the users it is available to", async () => {
        const registry = createRegistry().register({
            id: "calendar",
            summary: "",
            skill: "",
            tools: [],
            available: (userId) => userId === "u1",
        });
        expect((await registry.available("u1")).map((c) => c.id)).toContain("calendar");
        expect((await registry.available("u2")).map((c) => c.id)).not.toContain("calendar");
    });

    it("rejects a tool not named after its capability", () => {
        const registry = new CapabilityRegistry();
        expect(() =>
            registry.register({
                id: "notes",
                summary: "",
                skill: "",
                tools: [
                    {
                        name: "save_note",
                        label: "",
                        description: "",
                        parameters: {} as never,
                        effect: "read",
                        execute: async () => ({ data: null }),
                    },
                ],
            }),
        ).toThrow();
    });
});
