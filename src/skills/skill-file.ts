import { parse } from "yaml";

/** `conscious.json` next to a skill's `SKILL.md`: what Conscious knows that the skill itself does not say. */
export interface SkillSidecar {
    /** The project a copied skill came from. Its license is in `licenses/` and the copy in THIRD_PARTY_NOTICES.md. */
    source?: { repo: string; path: string; commit: string; license: string };
    /** The skill fetches from the web, so it is hidden on a computer without internet. */
    internet?: boolean;
    /** The skill keeps files, so it is hidden on installs without a computer even when it has no scripts. */
    computer?: boolean;
}

export interface SkillRequirements {
    /** Every one must be installed. */
    bins: string[];
    /** At least one must be installed. */
    anyBins: string[];
    /**
     * Secrets, another agent's settings or another agent's tools. Nothing on the computer provides
     * them (it holds no secrets), so a skill that needs one stays hidden.
     */
    external: string[];
    /** Operating systems the skill runs on. Empty means any. */
    os: string[];
}

export interface SkillInfo {
    name: string;
    description: string;
    requires: SkillRequirements;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
// A skill name is also a folder name and a word in the prompt.
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

// Listed as strings, or as objects with a name or path. An entry marked optional is not a requirement.
const names = (value: unknown): string[] =>
    Array.isArray(value)
        ? value.flatMap((item) => {
              if (typeof item === "string") return [item];
              const entry = record(item);
              if (entry.optional === true) return [];
              const name = entry.name ?? entry.path;
              return typeof name === "string" ? [name] : [];
          })
        : [];

const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * Reads a `SKILL.md` in the AgentSkills format. Requirements are read from `metadata.conscious`,
 * and from the same keys under any other agent's metadata, so a copied skill loads without edits.
 */
export const parseSkillFile = (text: string, folder: string): SkillInfo | undefined => {
    const match = FRONTMATTER.exec(text);
    if (!match?.[1]) return undefined;
    let front: Record<string, unknown>;
    try {
        front = record(parse(match[1]));
    } catch {
        return undefined;
    }
    const name = typeof front.name === "string" ? front.name.trim() : folder;
    const description = typeof front.description === "string" ? front.description.trim() : "";
    if (!SKILL_NAME.test(name) || !description) return undefined;

    const sections = Object.values(record(front.metadata)).map(record);
    const from = (read: (section: Record<string, unknown>) => unknown) =>
        sections.flatMap((section) => strings(read(section)));
    return {
        name,
        description,
        requires: {
            bins: [
                ...from((section) => record(section.requires).bins),
                ...from((section) => record(section.prerequisites).commands),
            ],
            anyBins: from((section) => record(section.requires).anyBins),
            external: [
                ...from((section) => record(section.requires).env),
                ...from((section) => record(section.requires).config),
                ...from((section) => record(section.prerequisites).env_vars),
                ...names(front.required_environment_variables),
                ...names(front.required_credential_files),
                ...from((section) => section.requires_toolsets).filter((toolset) => toolset !== "terminal"),
            ],
            os: [...from((section) => section.os), ...strings(front.platforms)].map((os) =>
                os === "darwin" ? "macos" : os,
            ),
        },
    };
};

export const parseSidecar = (text: string | undefined): SkillSidecar => {
    if (!text) return {};
    try {
        return record(JSON.parse(text)) as SkillSidecar;
    } catch {
        return {};
    }
};
