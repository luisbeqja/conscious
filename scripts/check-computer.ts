import { Sandbox as E2BSandbox } from "e2b";
import { loadConfig } from "../src/config.js";
import { createE2BClient, E2BSandboxes, userKey } from "../src/sandbox/e2b.js";
import { SkillLibrary } from "../src/skills/library.js";

/**
 * Starts a throwaway computer with the settings in .env, and checks what a user's computer
 * would have: internet, the programs skills need, and which skills show up. Deletes it after.
 */
const config = loadConfig();
if (!config.sandbox) {
    console.error("Set CONSCIOUS_SANDBOX=e2b and E2B_API_KEY in .env first.");
    process.exit(1);
}
const options = config.sandbox;
const user = `computer-check-${Date.now()}`;
const sandboxes = new E2BSandboxes(createE2BClient(options), options.idleMs);
const ok = (good: boolean, text: string) => console.log(`${good ? "✓" : "✗"} ${text}`);

console.log(`Starting a test computer (template ${options.template}, internet ${options.internet ? "on" : "off"})…`);
const started = Date.now();
const sandbox = await sandboxes.forUser(user);
ok(true, `computer ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);

try {
    const web = await sandbox.run(
        "curl -sS -o /dev/null -w '%{http_code}' --max-time 10 'https://api.open-meteo.com/v1/forecast?latitude=45.46&longitude=9.19&current=temperature_2m'",
        { timeoutMs: 20_000 },
    );
    const online = web.stdout.trim() === "200";
    ok(
        online === options.internet,
        `internet ${online ? "works" : "is off"}${online === options.internet ? "" : `, but CONSCIOUS_SANDBOX_INTERNET=${options.internet}`}`,
    );

    const bins = ["curl", "python3", "pip", "node", "git", "jq", "ffmpeg", "pdftotext", "libreoffice"];
    const found = await sandbox.run(
        `for b in ${bins.join(" ")}; do command -v $b >/dev/null 2>&1 && echo $b; done; true`,
    );
    const present = new Set(found.stdout.split("\n").filter(Boolean));
    for (const bin of bins) ok(present.has(bin), `${bin}${present.has(bin) ? "" : " missing"}`);

    const library = new SkillLibrary({ internet: options.internet });
    const skills = await library.list(sandbox);
    console.log(`\n${skills.length} skills show up:`);
    for (const skill of skills) console.log(`  ${skill.name}${skill.internet ? " (internet)" : ""}`);
    if (!options.internet)
        console.log("\nSkills that fetch from the web stay hidden until CONSCIOUS_SANDBOX_INTERNET=true.");
} finally {
    const connection = { apiKey: options.apiKey, domain: options.domain, proxy: options.proxy };
    const found = await createE2BClient(options).find({ conscious: userKey(user) });
    if (found) await (await E2BSandbox.connect(found, connection)).kill();
    console.log("\nTest computer deleted.");
}
