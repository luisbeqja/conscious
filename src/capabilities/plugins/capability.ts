import { Type } from "typebox";
import { notConnectedGuidance } from "../../plugins/connectors.js";
import { type PluginPackage, pluginConnector } from "../../plugins/manifest.js";
import type { PluginDeps } from "../../plugins/plugins.js";
import { reviewPlugin } from "../../plugins/review.js";
import { promptFile } from "../../prompts/prompt-file.js";
import { type Capability, defineTool } from "../types.js";

const Fixture = Type.Object({
    match: Type.String({ description: "`METHOD https://host/path`, without the query string" }),
    status: Type.Integer(),
    body: Type.Unknown(),
});

/** Plugins: install the bundled ones, or write one for an app Conscious does not support yet. */
export const createPluginsCapability = (deps: PluginDeps): Capability => {
    const search = defineTool({
        name: "plugins_search_plugins",
        label: "Search plugins",
        description:
            "Search the plugins on this Conscious for an app or service, e.g. 'bike sharing': the bundled ones and those you wrote for the user.",
        effect: "read",
        parameters: Type.Object({ query: Type.String() }),
        execute: async (params, context) => {
            const installed = new Set(deps.installs.list(context.userId).map((install) => install.id));
            const results = deps.registry
                .search(params.query, context.userId)
                .map((listing) => ({ ...listing, installed: installed.has(listing.id) }));
            return { data: results };
        },
    });

    const install = defineTool({
        name: "plugins_install_plugin",
        label: "Install a plugin",
        description:
            "Install the newest version of a plugin for the user. Its tools are usable from their next message.",
        effect: "draft",
        parameters: Type.Object({ id: Type.String() }),
        execute: async (params, context) => {
            const version = deps.registry.latest(params.id, context.userId);
            if (!version) return { data: { installed: false, reason: `No plugin "${params.id}"` } };
            const { manifest } = version.pkg;
            deps.installs.add(context.userId, { id: manifest.id, version: manifest.version, hash: version.hash });
            const connector = pluginConnector(manifest);
            const connected = connector
                ? Boolean(await deps.credentials.credential(context.userId, connector.id))
                : true;
            return {
                data: {
                    installed: true,
                    id: manifest.id,
                    version: manifest.version,
                    source: version.source,
                    connected,
                },
                guidance: !connected && connector ? notConnectedGuidance(connector) : undefined,
            };
        },
    });

    const remove = defineTool({
        name: "plugins_remove_plugin",
        label: "Remove a plugin",
        description: "Uninstall a plugin for the user.",
        effect: "draft",
        parameters: Type.Object({ id: Type.String() }),
        execute: async (params, context) => ({ data: { removed: deps.installs.remove(context.userId, params.id) } }),
    });

    const list = defineTool({
        name: "plugins_list_plugins",
        label: "List installed plugins",
        description: "The user's installed plugins, their versions, and whether each is working.",
        effect: "read",
        parameters: Type.Object({}),
        execute: async (_params, context) => ({
            data: deps.installs.list(context.userId).map((install) => {
                const version = deps.registry.get(install.id, install.version);
                return {
                    id: install.id,
                    version: install.version,
                    source: version?.source,
                    disabled: version?.quarantined,
                };
            }),
        }),
    });

    const create = defineTool({
        name: "plugins_create_plugin",
        label: "Create a plugin",
        description:
            "Write a new plugin (or a new version of one you wrote) for an app no plugin covers. It is reviewed and tested in a sandbox; if it passes, it is installed for this user only. Fix the problems it returns and try again.",
        effect: "draft",
        parameters: Type.Object({
            manifest: Type.Object(
                {},
                { additionalProperties: true, description: "id, version, name, summary, hosts, auth?, tools" },
            ),
            code: Type.String({ description: "One ES module with no imports that exports `tools`" }),
            skill: Type.String({ description: "Short notes on using the tools well" }),
            tests: Type.Array(
                Type.Object({
                    tool: Type.String(),
                    params: Type.Object({}, { additionalProperties: true }),
                    responses: Type.Array(Fixture),
                }),
                { description: "At least one per tool, with recorded responses instead of the network" },
            ),
        }),
        execute: async (params, context) => {
            const pkg = params as unknown as PluginPackage;
            const review = await reviewPlugin(pkg, deps.sandbox);
            if (!review.passed) return { data: { installed: false, problems: review.problems } };
            try {
                const version = deps.registry.publish(pkg, { author: context.userId, source: "agent" });
                deps.installs.add(context.userId, {
                    id: pkg.manifest.id,
                    version: pkg.manifest.version,
                    hash: version.hash,
                });
                return {
                    data: { installed: true, id: pkg.manifest.id, version: pkg.manifest.version },
                };
            } catch (error) {
                return { data: { installed: false, problems: [(error as Error).message] } };
            }
        },
    });

    return {
        id: "plugins",
        summary: "Plugins: install one for an app Conscious has no tools for, or write one when none exists.",
        skill: promptFile(import.meta.url, "SKILL.md"),
        tools: [search, install, remove, list, create],
    };
};
