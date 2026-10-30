import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir, hostname } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAC_PAIR_PATH } from "../protocol.js";
import { listFolders, realFolder } from "./folders.js";
import { agentState, installAgent, logFile, uninstallAgent } from "./launchd.js";
import { MacLink } from "./link.js";
import { type MacSettings, PERMISSION_MODES, readSettings, settingsFile, writeSettings } from "./settings.js";
import { MacPage, PAGE_PORT, pageKey } from "./ui.js";

const USAGE = `conscious-mac: Claude Code on this Mac, for Conscious.

  pnpm mac                         open its page: link this Mac with a QR, and every setting
  pnpm mac pair <address> <code>   link this Mac without the page (send /mac in the chat for both)
  pnpm mac allow <folder>          let Claude Code work in a folder
  pnpm mac forbid <folder>         take a folder back
  pnpm mac install                 keep it running, from every login on
  pnpm mac uninstall               stop it, and take it out of login
  pnpm mac run                     run it here, in the foreground
  pnpm mac status                  what is set up
  pnpm mac model <name|default>    the Claude model for these jobs
  pnpm mac mode <mode>             Claude Code's permission mode (acceptEdits)`;

const file = settingsFile();
const port = Number(process.env.CONSCIOUS_MAC_PORT) || PAGE_PORT;

const fail = (message: string): never => {
    console.error(message);
    process.exit(1);
};

const paired = (): MacSettings =>
    readSettings(file) ?? fail("This Mac is not linked yet: send /mac in the chat, then run what it says.");

/** The Mac's name as its owner set it, like "Luis's MacBook Pro". */
const macName = (): string =>
    spawnSync("scutil", ["--get", "ComputerName"], { encoding: "utf8" }).stdout?.trim() || hostname();

/**
 * Where Claude Code is installed: the user's own install first, where its installers put it, then
 * the PATH. A shell alias does not count, since launchd never sees it.
 */
const findClaude = (): string | undefined =>
    [
        join(homedir(), ".local", "bin", "claude"),
        join(homedir(), ".claude", "local", "claude"),
        ...(process.env.PATH ?? "")
            .split(delimiter)
            .filter(Boolean)
            .map((folder) => join(folder, "claude")),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
    ].find((path) => {
        try {
            accessSync(path, constants.X_OK);
            return true;
        } catch {
            return false;
        }
    });

const claudeVersion = (claude: string): string | undefined =>
    spawnSync(claude, ["--version"], { encoding: "utf8", timeout: 20_000 }).stdout?.trim() || undefined;

const showFolders = (settings: MacSettings) => {
    console.log(
        settings.folders.length
            ? `Claude Code may work in:\n${listFolders(settings.folders)
                  .map((folder) => `  ${folder.name}  ${folder.path}`)
                  .join("\n")}`
            : "No folder is allowed yet: pnpm mac allow <folder>",
    );
};

const pair = async (address?: string, code?: string) => {
    if (!address || !code) return fail("Run it as: pnpm mac pair <address> <code>. Send /mac in the chat for both.");
    const server = new URL(address).origin;
    const name = macName();
    const response = await fetch(new URL(MAC_PAIR_PATH, server), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, name }),
    }).catch((error: unknown) => fail(`Could not reach ${server}: ${error instanceof Error ? error.message : error}`));
    const body = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
    if (!response.ok || !body.token) return fail(body.error ?? `${server} answered ${response.status}.`);
    const before = readSettings(file);
    const claude = findClaude() ?? before?.claude;
    const settings: MacSettings = {
        server,
        token: body.token,
        name,
        folders: before?.folders ?? [],
        claude: claude ?? "claude",
        permissionMode: before?.permissionMode ?? "acceptEdits",
        model: before?.model,
    };
    writeSettings(file, settings);
    console.log(`"${name}" is linked to ${server}. Its token is in ${file}, readable by you alone.`);
    if (!claude || !claudeVersion(settings.claude)) {
        console.log("Claude Code was not found: install it, sign in with `claude`, then pair again.");
    }
    showFolders(settings);
    console.log("Then: pnpm mac install, to keep it running.");
};

const allow = (path?: string) => {
    const settings = paired();
    if (!path) return fail("Run it as: pnpm mac allow <folder>");
    const folder = realFolder(path) ?? fail(`${path} is not a folder on this Mac.`);
    settings.folders = [...new Set([...settings.folders, folder])];
    writeSettings(file, settings);
    showFolders(settings);
    // Claude Code works on what it is let into: the home folder is all of the user's files.
    const home = realFolder(homedir()) ?? homedir();
    const holdsHome = relative(folder, home);
    if (holdsHome === "" || (!holdsHome.startsWith("..") && !isAbsolute(holdsHome))) {
        console.log(
            "That is your whole home folder: Claude Code may now work on any file you have, keys and sign-ins included. `pnpm mac forbid` takes it back.",
        );
    }
};

const forbid = (path?: string) => {
    const settings = paired();
    if (!path) return fail("Run it as: pnpm mac forbid <folder>");
    const real = realFolder(path);
    const kept = settings.folders.filter((folder) => folder !== real && listFolders([folder])[0]?.name !== path);
    if (kept.length === settings.folders.length) fail(`${path} was not allowed.`);
    writeSettings(file, { ...settings, folders: kept });
    showFolders({ ...settings, folders: kept });
};

const setModel = (model?: string) => {
    const settings = paired();
    if (!model) return fail("Run it as: pnpm mac model <name>, like sonnet or opus, or default.");
    writeSettings(file, { ...settings, model: model === "default" ? undefined : model });
    console.log(model === "default" ? "Claude Code picks its own model." : `Claude Code works with ${model}.`);
};

const setMode = (mode?: string) => {
    const settings = paired();
    if (!mode || !PERMISSION_MODES.includes(mode)) return fail(`Pick one of: ${PERMISSION_MODES.join(", ")}`);
    writeSettings(file, { ...settings, permissionMode: mode });
    if (mode === "bypassPermissions") {
        console.log(
            "Claude Code will now run anything a message asks for, with nobody to stop it. Keep it for a Mac you can afford to lose.",
        );
    } else {
        console.log(`Claude Code works in ${mode} mode; anything it would ask about is refused.`);
    }
};

/** Whether conscious-mac is running with its page, here or in the background. */
const pageUp = async (): Promise<boolean> => {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_500) });
        return ((await response.json()) as { app?: string }).app === "conscious-mac";
    } catch {
        return false;
    }
};

/** The background program, with its page, linked or waiting to be. It keeps running until stopped from the page. */
const run = async () => {
    if (await pageUp()) {
        return fail(
            "conscious-mac already runs in the background: pnpm mac opens its page, pnpm mac uninstall stops it.",
        );
    }
    const stop = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop.abort());
    const link = new MacLink(file);
    const macPage = new MacPage({
        file,
        link,
        port,
        name: macName,
        findClaude,
        claudeVersion,
        log: logFile(),
        stop: () => {
            uninstallAgent();
            stop.abort();
        },
    });
    const server = await macPage.listen().catch((error: unknown) => {
        console.error(`Its page could not start on port ${port}: ${error instanceof Error ? error.message : error}`);
        return undefined;
    });
    if (server) console.log(`Its page: http://localhost:${port}, opened with pnpm mac`);
    await link.stayLinked(stop.signal);
    server?.close();
    process.exit(0);
};

/** Starts conscious-mac in the background, from now and at every login, in place of any older one. */
const startInBackground = () => {
    const claude = readSettings(file)?.claude || findClaude();
    const cli = fileURLToPath(import.meta.url);
    const repo = resolve(dirname(cli), "..", "..", "..");
    const path = [
        ...new Set([
            dirname(process.execPath),
            ...(claude ? [dirname(claude)] : []),
            ...(process.env.PATH ?? "").split(delimiter),
        ]),
    ]
        .filter(Boolean)
        .join(delimiter);
    installAgent({
        // Launchd starts it in the repository, where tsx is found whatever version pnpm installed.
        program: [process.execPath, "--import", "tsx", cli, "run"],
        directory: repo,
        env: {
            PATH: path,
            ...(process.env.CONSCIOUS_MAC_SETTINGS ? { CONSCIOUS_MAC_SETTINGS: file } : {}),
            ...(process.env.CONSCIOUS_MAC_PORT ? { CONSCIOUS_MAC_PORT: String(port) } : {}),
        },
        log: logFile(),
    });
};

const install = () => {
    startInBackground();
    console.log(`conscious-mac is running, and starts at every login. Its page: pnpm mac. Its log: ${logFile()}`);
};

/** `pnpm mac`: makes sure this version runs in the background, then opens its page in the browser. */
const openPage = async () => {
    if (!(await pageUp())) {
        // Not running, or an older version without the page: this one takes its place.
        startInBackground();
        const started = Date.now();
        while (!(await pageUp())) {
            if (Date.now() - started > 20_000) return fail(`conscious-mac did not start. Its log: ${logFile()}`);
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
    spawnSync("open", [`http://localhost:${port}/open?key=${pageKey(file)}`]);
    console.log(`Conscious on this Mac: http://localhost:${port}`);
};

const status = () => {
    const settings = readSettings(file);
    if (!settings?.token) return console.log("Not linked: run pnpm mac, and scan the code on its page.");
    console.log(`${settings.name}, linked to ${settings.server}`);
    showFolders(settings);
    console.log(`Claude Code: ${settings.claude} (${claudeVersion(settings.claude) ?? "not found"})`);
    console.log(`Permission mode: ${settings.permissionMode}. Model: ${settings.model ?? "Claude Code's default"}.`);
    console.log(`In the background: ${agentState()}. Page: http://localhost:${port}. Log: ${logFile()}`);
};

const [command = "", ...args] = process.argv.slice(2);
const commands: Record<string, () => unknown> = {
    "": openPage,
    help: () => console.log(USAGE),
    pair: () => pair(args[0], args[1]),
    allow: () => allow(args.join(" ")),
    forbid: () => forbid(args.join(" ")),
    model: () => setModel(args[0]),
    mode: () => setMode(args[0]),
    install,
    uninstall: () => console.log(uninstallAgent() ? "Stopped, and out of login." : "It was not installed."),
    run,
    status,
};
const chosen = commands[command];
if (!chosen) {
    console.log(USAGE);
    process.exit(1);
}
await chosen?.();
