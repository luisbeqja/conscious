import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectLicense, importSkill, repoSlug } from "../src/skills/import.js";
import { DEFAULT_BUNDLED_DIR, readBundledSkills, SIDECAR } from "../src/skills/library.js";
import { parseSidecar } from "../src/skills/skill-file.js";

const MIT = "MIT License\n\nCopyright (c) 2026 Upstream\n\nPermission is hereby granted, free of charge, to any person";

/** An upstream git repo with one skill, and the commit it sits at. No license text when `license` is undefined. */
const upstream = (license: string | undefined, skillFront = "") => {
    const repo = mkdtempSync(join(tmpdir(), "upstream-"));
    const git = (...args: string[]) =>
        execFileSync("git", args, {
            cwd: repo,
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: "t",
                GIT_AUTHOR_EMAIL: "t@t",
                GIT_COMMITTER_NAME: "t",
                GIT_COMMITTER_EMAIL: "t@t",
            },
        }).toString();
    git("init", "-q");
    if (license !== undefined) writeFileSync(join(repo, "LICENSE"), license);
    mkdirSync(join(repo, "skills/weather/scripts"), { recursive: true });
    writeFileSync(
        join(repo, "skills/weather/SKILL.md"),
        `---\nname: weather\ndescription: Forecasts.\n${skillFront}---\n\nUse curl.\n`,
    );
    writeFileSync(join(repo, "skills/weather/scripts/get.sh"), "curl wttr.in");
    git("add", ".");
    git("commit", "-q", "-m", "skill");
    return { repo, commit: git("rev-parse", "HEAD").trim() };
};

const target = () => {
    const root = mkdtempSync(join(tmpdir(), "conscious-"));
    return { skillsDir: join(root, "skills"), licensesDir: join(root, "licenses") };
};

describe("importing a skill", () => {
    it("copies the folder at the pinned commit, records where it came from and keeps the license", () => {
        const { repo, commit } = upstream(MIT);
        const dirs = target();

        const result = importSkill({ repo, path: "skills/weather", commit, internet: true, ...dirs });

        expect(result).toEqual({ name: "weather", license: "MIT" });
        expect(readFileSync(join(dirs.skillsDir, "weather/scripts/get.sh"), "utf8")).toBe("curl wttr.in");
        expect(JSON.parse(readFileSync(join(dirs.skillsDir, "weather/conscious.json"), "utf8"))).toEqual({
            source: { repo, path: "skills/weather", commit, license: "MIT" },
            internet: true,
        });
        expect(readFileSync(join(dirs.licensesDir, `${repoSlug(repo)}.txt`), "utf8")).toBe(MIT);
    });

    it("refuses a branch name, a skill that is already there, and an unknown license", () => {
        const { repo, commit } = upstream(MIT);
        const dirs = target();
        expect(() => importSkill({ repo, path: "skills/weather", commit: "main", ...dirs })).toThrow("40-character");
        importSkill({ repo, path: "skills/weather", commit, ...dirs });
        expect(() => importSkill({ repo, path: "skills/weather", commit, ...dirs })).toThrow("--replace");

        const closed = upstream("All rights reserved.");
        expect(() =>
            importSkill({ repo: closed.repo, path: "skills/weather", commit: closed.commit, ...target() }),
        ).toThrow("not MIT or Apache-2.0");

        const unlicensed = upstream(undefined, "license: MIT\n");
        expect(() =>
            importSkill({ repo: unlicensed.repo, path: "skills/weather", commit: unlicensed.commit, ...target() }),
        ).toThrow("no license text");
    });

    it("trusts the license a skill declares over its repo's", () => {
        const { repo, commit } = upstream(MIT, "license: Apache-2.0\n");
        expect(importSkill({ repo, path: "skills/weather", commit, ...target() }).license).toBe("Apache-2.0");
    });

    it("names a project's license file after its owner and repo", () => {
        expect(repoSlug("https://github.com/NousResearch/hermes-agent.git")).toBe("nousresearch-hermes-agent");
        expect(repoSlug("git@github.com:openclaw/openclaw.git")).toBe("openclaw-openclaw");
    });

    it("recognises MIT and Apache-2.0 license texts", () => {
        expect(detectLicense(MIT)).toBe("MIT");
        expect(detectLicense("Apache License\n Version 2.0, January 2004")).toBe("Apache-2.0");
        expect(detectLicense("GNU GENERAL PUBLIC LICENSE")).toBeUndefined();
    });
});

describe("the skills the repo copied", () => {
    it("are each in THIRD_PARTY_NOTICES.md, with their project's license in licenses/", () => {
        const root = new URL("../", import.meta.url);
        const notices = readFileSync(new URL("THIRD_PARTY_NOTICES.md", root), "utf8");
        const copied = readBundledSkills(DEFAULT_BUNDLED_DIR).flatMap((skill) => {
            const source = parseSidecar(skill.files.get(SIDECAR)).source;
            return source ? [{ name: skill.name, source }] : [];
        });

        expect(copied.length).toBeGreaterThan(0);
        for (const { name, source } of copied) {
            expect(notices, name).toContain(`| \`${name}\` | [`);
            expect(notices, name).toContain(`/tree/${source.commit}/${source.path})`);
            expect(existsSync(new URL(`licenses/${repoSlug(source.repo)}.txt`, root)), name).toBe(true);
        }
    });
});
