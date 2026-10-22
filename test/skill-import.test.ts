import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectLicense, importSkill } from "../src/skills/import.js";

const MIT = "MIT License\n\nCopyright (c) 2026 Upstream\n\nPermission is hereby granted, free of charge, to any person";

/** An upstream git repo with one skill, and the commit it sits at. */
const upstream = (license: string, skillFront = "") => {
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
    writeFileSync(join(repo, "LICENSE"), license);
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
    return { skillsDir: join(root, "skills") };
};

describe("importing a skill", () => {
    it("copies the folder at the pinned commit and checks its license", () => {
        const { repo, commit } = upstream(MIT);
        const dirs = target();

        const result = importSkill({ repo, path: "skills/weather", commit, internet: true, ...dirs });

        expect(result).toEqual({ name: "weather", license: "MIT" });
        expect(readFileSync(join(dirs.skillsDir, "weather/scripts/get.sh"), "utf8")).toBe("curl wttr.in");
        expect(JSON.parse(readFileSync(join(dirs.skillsDir, "weather/conscious.json"), "utf8"))).toEqual({
            internet: true,
        });
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
    });

    it("trusts the license a skill declares over its repo's", () => {
        const { repo, commit } = upstream(MIT, "license: Apache-2.0\n");
        expect(importSkill({ repo, path: "skills/weather", commit, ...target() }).license).toBe("Apache-2.0");
    });

    it("recognises MIT and Apache-2.0 license texts", () => {
        expect(detectLicense(MIT)).toBe("MIT");
        expect(detectLicense("Apache License\n Version 2.0, January 2004")).toBe("Apache-2.0");
        expect(detectLicense("GNU GENERAL PUBLIC LICENSE")).toBeUndefined();
    });
});
