import { parseArgs } from "node:util";
import { importSkill } from "../src/skills/import.js";

// pnpm skills:import <repo> <path> --commit <sha> [--name <name>] [--internet] [--replace]
const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
        commit: { type: "string" },
        name: { type: "string" },
        internet: { type: "boolean", default: false },
        replace: { type: "boolean", default: false },
    },
});
const [repo, path] = positionals;
if (!repo || !path || !values.commit) {
    console.error(
        "Usage: pnpm skills:import <repo-url> <path/to/skill> --commit <40-char sha> [--name <name>] [--internet] [--replace]",
    );
    process.exit(1);
}

const imported = importSkill({
    repo,
    path,
    commit: values.commit,
    name: values.name,
    internet: values.internet,
    replace: values.replace,
    skillsDir: "skills",
    licensesDir: "licenses",
});
console.log(
    `Copied skills/${imported.name} (${imported.license}). Add it to THIRD_PARTY_NOTICES.md, review it, then commit it.`,
);
