import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { type Connector, hostProblems, resolveConnector } from "./connectors.js";

const ID = "^[a-z][a-z0-9]{1,30}$";
const VERSION = "^\\d+\\.\\d+\\.\\d+$";

const PluginTool = Type.Object({
    /** `<plugin id>_<verb>_<noun>`, the same rule as built-in capabilities. */
    name: Type.String({ pattern: "^[a-z][a-z0-9]*_[a-z0-9_]+$" }),
    label: Type.String({ minLength: 1, maxLength: 60 }),
    description: Type.String({ minLength: 1, maxLength: 600 }),
    effect: Type.Union([Type.Literal("read"), Type.Literal("draft"), Type.Literal("commit")]),
    /** JSON Schema for the arguments; must describe an object. */
    parameters: Type.Unsafe<{ type: "object"; [keyword: string]: unknown }>(
        Type.Object({ type: Type.Literal("object") }, { additionalProperties: true }),
    ),
});

export const PluginManifestSchema = Type.Object({
    id: Type.String({ pattern: ID }),
    version: Type.String({ pattern: VERSION }),
    name: Type.String({ minLength: 1, maxLength: 60 }),
    summary: Type.String({ minLength: 1, maxLength: 200 }),
    /** Every host the plugin may call. The broker refuses anything else. */
    hosts: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 5 }),
    /** The user's account the plugin acts as. The broker adds the token; the plugin never sees it. */
    auth: Type.Optional(
        Type.Object({
            connector: Type.String({ pattern: ID }),
            scopes: Type.Optional(Type.Array(Type.String())),
            /** The rest defines a connector that is not built in. */
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
            hosts: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 5 })),
            howTo: Type.Optional(
                Type.Object({
                    url: Type.String(),
                    steps: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 5 }),
                }),
            ),
            verifyUrl: Type.Optional(Type.String()),
            header: Type.Optional(Type.String()),
        }),
    ),
    tools: Type.Array(PluginTool, { minItems: 1, maxItems: 20 }),
});

export type PluginManifest = Static<typeof PluginManifestSchema>;
export type PluginToolSpec = PluginManifest["tools"][number];

/** A recorded response a plugin test replays instead of the network. */
export interface FixtureResponse {
    /** `METHOD https://host/path`, matched against the request without its query string. */
    match: string;
    status: number;
    body: unknown;
}

export interface PluginTest {
    tool: string;
    params: Record<string, unknown>;
    responses: FixtureResponse[];
}

/** Everything one version of a plugin is: what it declares, its code, how to use it, how to test it. */
export interface PluginPackage {
    manifest: PluginManifest;
    /** One ES module, no imports: `export const tools = { <tool name>: async (params, ctx) => result }`. */
    code: string;
    skill: string;
    tests: PluginTest[];
}

/** The connector a plugin acts through, or undefined for a plugin that uses only public APIs. */
export const pluginConnector = (manifest: PluginManifest): Connector | undefined =>
    manifest.auth && resolveConnector(manifest.auth).connector;

/** Problems with a manifest, in words an agent can act on. Empty when it is valid. */
export const manifestProblems = (manifest: unknown): string[] => {
    if (!Value.Check(PluginManifestSchema, manifest)) {
        return [...Value.Errors(PluginManifestSchema, manifest)].map(
            (error) => `manifest${error.instancePath || ""}: ${error.message}`,
        );
    }
    const problems = hostProblems("hosts", manifest.hosts);
    if (manifest.auth) {
        const { connector, problems: authProblems } = resolveConnector(manifest.auth);
        problems.push(...authProblems);
        if (connector) {
            const outside = manifest.hosts.filter((host) => !connector.hosts.includes(host));
            if (outside.length) {
                problems.push(
                    `hosts: a plugin acting as the user's ${connector.name} account may only call ${connector.hosts.join(", ")}, not ${outside.join(", ")}`,
                );
            }
        }
    }
    const names = new Set<string>();
    for (const tool of manifest.tools) {
        if (!tool.name.startsWith(`${manifest.id}_`)) {
            problems.push(`tools: "${tool.name}" must be named "${manifest.id}_<verb>_<noun>"`);
        }
        if (names.has(tool.name)) problems.push(`tools: "${tool.name}" is declared twice`);
        names.add(tool.name);
    }
    return problems;
};
