import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sandbox } from "../sandbox/sandbox.js";
import { parseSidecar, parseSkillFile, SKILL_NAME, type SkillInfo } from "./skill-file.js";

/** Where skills live on the user's computer: the ones copied from the repo and the ones it learned. */
export const SKILLS_DIR = "skills";
/** Marks a skill copied from the repo, with the hash of what was copied. A skill without it is the user's own. */
export const BUNDLED_MARKER = ".bundled";
export const SIDECAR = "conscious.json";

export const DEFAULT_BUNDLED_DIR = fileURLToPath(new URL("../../skills/", import.meta.url));

export interface BundledSkill {
    name: string;
    /** Path inside the skill folder → content. */
    files: ReadonlyMap<string, string>;
    hash: string;
}

const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
    });

/** The skills that ship in the repo's `skills/` folder, each one a folder with a `SKILL.md`. */
export const readBundledSkills = (dir: string): BundledSkill[] => {
    let names: string[];
    try {
        names = readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
    } catch {
        return [];
    }
    return names
        .filter((name) => SKILL_NAME.test(name))
        .sort()
        .map((name) => {
            const root = join(dir, name);
            const files = new Map(
                walk(root)
                    .sort()
                    .map((path) => [relative(root, path).split("\\").join("/"), readFileSync(path, "utf8")] as const),
            );
            if (!files.has("SKILL.md")) throw new Error(`Bundled skill "${name}" has no SKILL.md`);
            const hash = createHash("sha256");
            for (const [path, content] of files) hash.update(`${path}\0${content}\0`);
            return { name, files, hash: hash.digest("hex").slice(0, 16) };
        });
};

export interface ListedSkill extends SkillInfo {
    path: string;
    bundled: boolean;
    internet: boolean;
}

export interface SkillLibraryOptions {
    bundledDir?: string;
    /** Whether the computers can reach the internet. Skills that need it are hidden when they cannot. */
    internet: boolean;
}

const quote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

/**
 * The skills each user's agent can use. Repo skills are copied into the computer the first time
 * a user is seen by this process (and again when they change); the agent reads them from there,
 * next to the skills it wrote itself. If both have one with the same name, the user's own wins.
 */
export class SkillLibrary {
    private readonly bundled: BundledSkill[];
    private readonly synced = new Set<string>();
    // Installed programs rarely change, so each answer is kept for the life of the process.
    private readonly installed = new Map<string, Map<string, boolean>>();

    constructor(private readonly options: SkillLibraryOptions) {
        this.bundled = readBundledSkills(options.bundledDir ?? DEFAULT_BUNDLED_DIR);
    }

    /**
     * Copies the repo's skills in, leaving alone any skill the user owns or that is already current,
     * and removes copies of skills the repo no longer ships.
     */
    async sync(userId: string, sandbox: Sandbox): Promise<void> {
        if (this.synced.has(userId)) return;
        await Promise.all(
            this.bundled.map(async (skill) => {
                const folder = `${SKILLS_DIR}/${skill.name}`;
                const [marker, own] = await Promise.all([
                    sandbox.readFile(`${folder}/${BUNDLED_MARKER}`),
                    sandbox.readFile(`${folder}/SKILL.md`),
                ]);
                if (marker === undefined && own !== undefined) return;
                if (marker?.trim() === skill.hash) return;
                for (const [path, content] of skill.files) await sandbox.writeFile(`${folder}/${path}`, content);
                // Written last, so a copy cut short is copied again next time.
                await sandbox.writeFile(`${folder}/${BUNDLED_MARKER}`, skill.hash);
            }),
        );
        const shipped = new Set(this.bundled.map((skill) => skill.name));
        const folders = await sandbox.listFiles(SKILLS_DIR).catch(() => []);
        await Promise.all(
            folders
                .filter((entry) => entry.type === "dir" && SKILL_NAME.test(entry.name) && !shipped.has(entry.name))
                .map(async ({ name }) => {
                    const folder = `${SKILLS_DIR}/${name}`;
                    // Without the marker the user owns it: they wrote it, or saved over a bundled one.
                    if ((await sandbox.readFile(`${folder}/${BUNDLED_MARKER}`)) === undefined) return;
                    await sandbox.run(`rm -rf ${quote(folder)}`);
                }),
        );
        this.synced.add(userId);
    }

    /** Every skill on the computer that can run there now. */
    async list(userId: string, sandbox: Sandbox): Promise<ListedSkill[]> {
        await this.sync(userId, sandbox);
        const folders = await sandbox.listFiles(SKILLS_DIR).catch(() => []);
        const found = await Promise.all(
            folders
                .filter((entry) => entry.type === "dir" && SKILL_NAME.test(entry.name))
                .map(async ({ name }): Promise<ListedSkill | undefined> => {
                    const folder = `${SKILLS_DIR}/${name}`;
                    const [text, sidecar, marker] = await Promise.all([
                        sandbox.readFile(`${folder}/SKILL.md`),
                        sandbox.readFile(`${folder}/${SIDECAR}`),
                        sandbox.readFile(`${folder}/${BUNDLED_MARKER}`),
                    ]);
                    const info = text === undefined ? undefined : parseSkillFile(text, name);
                    if (!info) return undefined;
                    return {
                        ...info,
                        path: `${folder}/SKILL.md`,
                        bundled: marker !== undefined,
                        internet: parseSidecar(sidecar).internet === true,
                    };
                }),
        );
        const skills = found.filter((skill): skill is ListedSkill => skill !== undefined);
        const installed = await this.checkInstalled(
            userId,
            sandbox,
            skills.flatMap((skill) => [...skill.requires.bins, ...skill.requires.anyBins]),
        );
        return skills.filter((skill) => this.canRun(skill, installed)).sort((a, b) => a.name.localeCompare(b.name));
    }

    /** The skills section of the system prompt. */
    async render(userId: string, sandbox: Sandbox): Promise<string> {
        const skills = await this.list(userId, sandbox);
        if (skills.length === 0) return "None yet.";
        return skills.map((skill) => `- \`${skill.name}\` (${skill.path}): ${skill.description}`).join("\n");
    }

    private canRun(skill: ListedSkill, installed: ReadonlyMap<string, boolean>): boolean {
        const { requires } = skill;
        if (requires.os.length > 0 && !requires.os.includes("linux")) return false;
        if (requires.external.length > 0) return false;
        if (skill.internet && !this.options.internet) return false;
        if (!requires.bins.every((bin) => installed.get(bin))) return false;
        return requires.anyBins.length === 0 || requires.anyBins.some((bin) => installed.get(bin));
    }

    private async checkInstalled(
        userId: string,
        sandbox: Sandbox,
        bins: readonly string[],
    ): Promise<ReadonlyMap<string, boolean>> {
        const known = this.installed.get(userId) ?? new Map<string, boolean>();
        this.installed.set(userId, known);
        const unknown = [...new Set(bins)].filter((bin) => !known.has(bin) && /^[\w.+-]+$/.test(bin));
        if (unknown.length > 0) {
            const script = `for b in ${unknown.map(quote).join(" ")}; do command -v "$b" >/dev/null 2>&1 && echo "$b"; done; true`;
            const result = await sandbox.run(script, { timeoutMs: 10_000 });
            const present = new Set(result.stdout.split("\n").map((line) => line.trim()));
            for (const bin of unknown) known.set(bin, present.has(bin));
        }
        return known;
    }
}
