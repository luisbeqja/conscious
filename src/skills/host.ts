import { DEFAULT_BUNDLED_DIR, readBundledSkills, SIDECAR } from "./library.js";
import { parseSidecar, parseSkillFile, type SkillInfo } from "./skill-file.js";

export interface HostSkill extends SkillInfo {
    files: ReadonlyMap<string, string>;
}

// `web_read_page` does what these skills use curl for.
const HOST_BINS = new Set(["curl"]);

/** Whether a skill works with only Conscious's own tools: no scripts to run and no files to keep. */
const runsWithoutComputer = (info: SkillInfo, files: ReadonlyMap<string, string>): boolean => {
    const { requires } = info;
    if ([...files.keys()].some((path) => path.startsWith("scripts/"))) return false;
    if (parseSidecar(files.get(SIDECAR)).computer) return false;
    if (requires.external.length > 0) return false;
    if (!requires.bins.every((bin) => HOST_BINS.has(bin))) return false;
    return requires.anyBins.length === 0 || requires.anyBins.some((bin) => HOST_BINS.has(bin));
};

/**
 * The repo's skills that need no computer, read straight from the repo, for installs that run
 * without one. The rest wait for a computer, where scripts can run.
 */
export const readHostSkills = (dir: string = DEFAULT_BUNDLED_DIR): HostSkill[] =>
    readBundledSkills(dir).flatMap((skill) => {
        const info = parseSkillFile(skill.files.get("SKILL.md") ?? "", skill.name);
        return info && runsWithoutComputer(info, skill.files) ? [{ ...info, files: skill.files }] : [];
    });
