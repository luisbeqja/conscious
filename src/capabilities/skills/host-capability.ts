import { Type } from "typebox";
import { promptFile } from "../../prompts/prompt-file.js";
import type { HostSkill } from "../../skills/host.js";
import { type Capability, defineTool } from "../types.js";

const GUIDE = promptFile(import.meta.url, "HOST.md");

/** Skills on an install without a computer: read from the repo, followed with the agent's own tools. */
export const createHostSkillsCapability = (skills: readonly HostSkill[]): Capability => {
    const read = defineTool({
        name: "skills_read_skill",
        label: "Read a skill",
        description: "Read a skill's instructions (SKILL.md), or one of its reference files by path.",
        effect: "read",
        parameters: Type.Object({
            name: Type.String(),
            file: Type.Optional(Type.String({ description: "A path inside the skill, e.g. references/units.md" })),
        }),
        execute: async (params) => {
            const skill = skills.find((candidate) => candidate.name === params.name);
            if (!skill)
                return { data: { error: `No skill "${params.name}". Known: ${skills.map((s) => s.name).join(", ")}` } };
            const path = params.file ?? "SKILL.md";
            const text = skill.files.get(path);
            if (text === undefined) {
                return { data: { error: `No ${path}. Files: ${[...skill.files.keys()].join(", ")}` } };
            }
            return { data: { name: skill.name, path, text: text.slice(0, 14_000) } };
        },
    });

    const list = skills.map((skill) => `- \`${skill.name}\`: ${skill.description}`).join("\n");
    return {
        id: "skills",
        summary: "Skills: instructions for jobs that come up often. Read one before you use it.",
        skill: `${GUIDE}\n\n${list}`,
        tools: [read],
    };
};
