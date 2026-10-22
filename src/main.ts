import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.js";
import { createConscious } from "./create-conscious.js";
import { modelSetupProblem } from "./engine/models.js";
import { connectServers } from "./mcp/servers.js";

const USER = "me";
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;

const config = loadConfig();
const problem = await modelSetupProblem(config.model);
if (problem) {
    console.error(problem);
    process.exit(1);
}
const mcp = await connectServers(config.mcpServers);
const terminal = createInterface({ input: stdin, output: stdout });

// Reminders and finished background tasks arrive on their own, so they print above the prompt.
const { orchestrator, scheduler, background, sandboxes, startVault } = createConscious(
    config,
    async (_userId, text) => {
        stdout.write(`\r\x1b[K${bold("conscious")} ${text}\n`);
        terminal.prompt(true);
    },
    mcp.capabilities,
);

const COMMANDS: Record<string, () => Promise<void> | void> = {
    "/reset": async () => {
        await orchestrator.reset(USER);
        console.log(dim("Conversation cleared."));
    },
    "/reminders": () => console.log(dim(JSON.stringify(scheduler.list(USER), null, 2))),
    "/tasks": () => console.log(dim(JSON.stringify(background.list(USER), null, 2))),
};

const vaultServer = startVault();
console.log(
    dim(
        `Conscious · ${config.model.provider}/${config.model.id} · ${config.timezone} · computer: ${config.sandbox ? "e2b" : "none"} · mcp: ${mcp.capabilities.map((capability) => capability.id).join(", ") || "none"}`,
    ),
);
console.log(dim(`Vault on ${config.vault.publicUrl}`));
console.log(dim(`Commands: ${Object.keys(COMMANDS).join(" ")} /exit\n`));
terminal.setPrompt("you ");

terminal.prompt();

// The iterator buffers lines typed (or piped) while a reply is still being written.
for await (const input of terminal) {
    const line = input.trim();
    if (line === "/exit") break;
    const command = COMMANDS[line];
    if (!line || command) {
        await command?.();
        terminal.prompt();
        continue;
    }
    stdout.write(`${bold("conscious")} `);
    let streamed = false;
    const reply = await orchestrator.send(USER, line, {
        onProgress: (progress) => {
            if (progress.type === "text") {
                streamed = true;
                stdout.write(progress.delta);
            } else {
                stdout.write(dim(`[${progress.name}] `));
            }
        },
        react: async (emoji) => {
            stdout.write(`${emoji} `);
            return true;
        },
    });
    // A failed run streams nothing; its fallback still has to be shown.
    stdout.write(streamed ? "\n\n" : `${reply}\n\n`);
    terminal.prompt();
}
terminal.close();
vaultServer.close();
scheduler.stopAll();
await sandboxes?.shutdown();
await mcp.close();
process.exit(0);
