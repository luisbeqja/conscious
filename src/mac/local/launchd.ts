import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

export const LABEL = "net.conscious.mac";

export const plistFile = (): string => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
export const logFile = (): string => join(homedir(), "Library", "Logs", "conscious-mac.log");

const xml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface AgentPlist {
    program: readonly string[];
    directory: string;
    env: Readonly<Record<string, string>>;
    log: string;
}

/** A LaunchAgent that starts conscious-mac at login and again after a crash, but not once it was unlinked. */
export const plist = (agent: AgentPlist): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${agent.program.map((part) => `        <string>${xml(part)}</string>`).join("\n")}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(agent.directory)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${Object.entries(agent.env)
    .map(([key, value]) => `        <key>${xml(key)}</key>\n        <string>${xml(value)}</string>`)
    .join("\n")}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>${xml(agent.log)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(agent.log)}</string>
</dict>
</plist>
`;

const target = () => `gui/${userInfo().uid}`;

/** Writes the LaunchAgent and starts it now, in place of any older one. */
export const installAgent = (agent: AgentPlist): void => {
    mkdirSync(dirname(plistFile()), { recursive: true });
    mkdirSync(dirname(agent.log), { recursive: true });
    spawnSync("launchctl", ["bootout", `${target()}/${LABEL}`], { stdio: "ignore" });
    writeFileSync(plistFile(), plist(agent));
    const started = spawnSync("launchctl", ["bootstrap", target(), plistFile()], { encoding: "utf8" });
    if (started.status !== 0) throw new Error(`launchctl did not start it: ${started.stderr.trim()}`);
};

/** Stops it and takes it out of login. False when it was not installed. */
export const uninstallAgent = (): boolean => {
    spawnSync("launchctl", ["bootout", `${target()}/${LABEL}`], { stdio: "ignore" });
    if (!existsSync(plistFile())) return false;
    rmSync(plistFile());
    return true;
};

/** "running", "not running", or "not installed". */
export const agentState = (): string => {
    if (!existsSync(plistFile())) return "not installed";
    const printed = spawnSync("launchctl", ["print", `${target()}/${LABEL}`], { encoding: "utf8" });
    return /state = running/.test(printed.stdout ?? "") ? "running" : "not running";
};
