import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIDECAR } from "./library.js";
import { parseSkillFile } from "./skill-file.js";

/** Licenses that let us copy a skill into an MIT project. */
const LICENSES: ReadonlyArray<{ id: string; test: RegExp }> = [
    { id: "MIT", test: /Permission is hereby granted, free of charge/ },
    { id: "Apache-2.0", test: /Apache License,?\s+Version 2\.0/ },
];

export const detectLicense = (text: string): string | undefined =>
    LICENSES.find((license) => license.test.test(text))?.id;

export interface ImportRequest {
    /** A git URL, or a local path in tests. */
    repo: string;
    /** The skill's folder inside that repo. */
    path: string;
    /** A full 40-character commit: what we copy is exactly what we reviewed. */
    commit: string;
    /** The repo's `skills/` folder. */
    skillsDir: string;
    name?: string;
    internet?: boolean;
    /** Replace a skill that is already there, for a bump to a newer commit. */
    replace?: boolean;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

/** Copies one skill folder from another project at a pinned commit. */
export const importSkill = (request: ImportRequest): { name: string; license: string } => {
    if (!/^[0-9a-f]{40}$/.test(request.commit)) throw new Error("--commit must be a full 40-character commit SHA");
    const checkout = mkdtempSync(join(tmpdir(), "conscious-import-"));
    try {
        git(checkout, "init", "-q");
        git(checkout, "remote", "add", "origin", request.repo);
        git(checkout, "fetch", "-q", "--depth", "1", "origin", request.commit);
        git(checkout, "checkout", "-q", "FETCH_HEAD");

        const source = join(checkout, request.path);
        const skillFile = join(source, "SKILL.md");
        if (!existsSync(skillFile)) throw new Error(`${request.path} has no SKILL.md at ${request.commit}`);
        const folder = request.path.split("/").filter(Boolean).at(-1) ?? "";
        const info = parseSkillFile(readFileSync(skillFile, "utf8"), folder);
        if (!info) throw new Error(`${request.path}/SKILL.md has no valid name and description`);
        const name = request.name ?? info.name;

        const repoLicenseFile = readdirSync(checkout).find((file) => /^licen[cs]e(\.md|\.txt)?$/i.test(file));
        const repoLicense = repoLicenseFile ? readFileSync(join(checkout, repoLicenseFile), "utf8") : "";
        const declared = /^license:\s*["']?([\w.-]+)/m.exec(readFileSync(skillFile, "utf8"))?.[1];
        const license = declared ?? detectLicense(repoLicense);
        if (!license || !LICENSES.some((known) => known.id === license)) {
            throw new Error(
                `Cannot copy ${request.path}: its license (${license ?? "none found"}) is not MIT or Apache-2.0`,
            );
        }

        const target = join(request.skillsDir, name);
        if (existsSync(target)) {
            if (!request.replace) throw new Error(`skills/${name} already exists; pass --replace to bump it`);
            rmSync(target, { recursive: true });
        }
        cpSync(source, target, { recursive: true });
        if (request.internet) writeFileSync(join(target, SIDECAR), `${JSON.stringify({ internet: true }, null, 4)}\n`);
        return { name, license };
    } finally {
        rmSync(checkout, { recursive: true, force: true });
    }
};
