import { Type } from "typebox";
import { CONNECTORS, type Connector } from "../../plugins/connectors.js";
import { promptFile } from "../../prompts/prompt-file.js";
import type { Vault } from "../../vault/vault.js";
import { type Capability, defineTool } from "../types.js";

/**
 * The Vault: the user's connected accounts. Secrets go in through a private page, never the chat.
 * `connectors` lists the accounts a user can connect: the built-in ones and those their plugins define.
 */
export const createVaultCapability = (
    vault: Vault,
    publicUrl: string,
    connectors: (userId: string) => Connector[] = () => [...CONNECTORS.values()],
): Capability => {
    const request = defineTool({
        name: "vault_request_connection",
        label: "Connect an account",
        description:
            "Create a private, single-use link where the user saves the token for an account (for example GitHub). Send them the link.",
        effect: "draft",
        parameters: Type.Object({
            connector: Type.String({
                description: "A built-in connector id (github, google), or the connector id of an installed plugin",
            }),
        }),
        execute: async (params, context) => {
            const available = connectors(context.userId);
            const connector = available.find((candidate) => candidate.id === params.connector);
            if (!connector) {
                const known = available.map((candidate) => candidate.id).join(", ");
                return {
                    data: {
                        error: `No "${params.connector}" connector. Known: ${known}. For another service, install or create a plugin that defines it first.`,
                    },
                };
            }
            const link = vault.createLink(context.userId, connector);
            return {
                data: { url: `${publicUrl.replace(/\/$/, "")}/vault/${link.code}`, expiresInMinutes: 15 },
                guidance:
                    "Send the url exactly as it is. Say it opens a private page and works once. You will be told when it is saved.",
            };
        },
    });

    const list = defineTool({
        name: "vault_list_connections",
        label: "List connected accounts",
        description: "Which of the user's accounts are connected, and which can be.",
        effect: "read",
        parameters: Type.Object({}),
        execute: async (_params, context) => {
            const connected = new Set(vault.connected(context.userId).map((entry) => entry.id));
            return {
                data: connectors(context.userId).map((connector) => ({
                    connector: connector.id,
                    name: connector.name,
                    connected: connected.has(connector.id),
                })),
            };
        },
    });

    const remove = defineTool({
        name: "vault_remove_connection",
        label: "Disconnect an account",
        description: "Delete the user's saved token for an account. Remind them to revoke it on the service too.",
        effect: "draft",
        parameters: Type.Object({ connector: Type.String() }),
        execute: async (params, context) => ({ data: { removed: vault.remove(context.userId, params.connector) } }),
    });

    return {
        id: "vault",
        summary: "The Vault: connect the user's accounts (GitHub, …) through a private page, and disconnect them.",
        skill: promptFile(import.meta.url, "SKILL.md"),
        tools: [request, list, remove],
    };
};
