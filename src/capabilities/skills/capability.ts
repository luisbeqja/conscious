import { Type } from "typebox";
import { stringify } from "yaml";
import { promptFile } from "../../prompts/prompt-file.js";
import type { SandboxProvider } from "../../sandbox/sandbox.js";
import { BUNDLED_MARKER, SKILLS_DIR } from "../../skills/library.js";
import { SKILL_NAME } from "../../skills/skill-file.js";
import { type Capability, defineTool } from "../types.js";

const HISTORY = ".history";

const folderOf = (name: string): string => {
    if (!SKILL_NAME.test(name))
        throw new Error("A skill name is lowercase letters, digits and dashes, like plan-a-trip");
    return `${SKILLS_DIR}/${name}`;
};

const skillFile = (name: string, description: string, instructions: string): string =>
    `---\n${stringify({ name, description })}---\n\n${instructions.trim()}\n`;

/**
 * Skills the agent writes for one user, on that user's computer. Every change keeps the version
 * before it in `.history/`, so nothing the agent learns is lost and the user can undo it.
 */
export const createSkillsCapability = (sandboxes: SandboxProvider, now: () => Date = () => new Date()): Capability => {
    /** Saves the current SKILL.md, if any, as a version and returns the computer for the next write. */
    const keepVersion = async (userId: string, folder: string) => {
        const sandbox = await sandboxes.forUser(userId);
        const current = await sandbox.readFile(`${folder}/SKILL.md`);
        if (current !== undefined) {
            const stamp = now().toISOString().replace(/[:.]/g, "-");
            await sandbox.writeFile(`${folder}/${HISTORY}/${stamp}.md`, current);
        }
        // From now on the skill is the user's own: the repo's copy must not replace it.
        await sandbox.run(`rm -f ${folder}/${BUNDLED_MARKER}`);
        return sandbox;
    };

    const save = defineTool({
        name: "skills_save_skill",
        label: "Save a skill",
        description:
            "Save a procedure as a skill on your computer, or replace one that misled you. The previous version is kept.",
        effect: "draft",
        parameters: Type.Object({
            name: Type.String({ description: "Lowercase words joined by dashes, like plan-a-trip." }),
            description: Type.String({ description: "One line: what the skill does and when to use it." }),
            instructions: Type.String({
                description: "The steps, in markdown, as you would want to read them next time.",
            }),
        }),
        execute: async (params, context) => {
            const folder = folderOf(params.name);
            const description = params.description.replace(/\s+/g, " ").trim();
            if (!description) throw new Error("A skill needs a one-line description");
            const sandbox = await keepVersion(context.userId, folder);
            await sandbox.writeFile(`${folder}/SKILL.md`, skillFile(params.name, description, params.instructions));
            return { data: { saved: `${folder}/SKILL.md` } };
        },
    });

    const listVersions = defineTool({
        name: "skills_list_versions",
        label: "List a skill's versions",
        description: "The earlier versions of a skill, newest first.",
        effect: "read",
        parameters: Type.Object({ name: Type.String() }),
        execute: async (params, context) => {
            const sandbox = await sandboxes.forUser(context.userId);
            const entries = await sandbox.listFiles(`${folderOf(params.name)}/${HISTORY}`).catch(() => []);
            const versions = entries
                .filter((entry) => entry.type === "file" && entry.name.endsWith(".md"))
                .map((entry) => entry.name.replace(/\.md$/, ""))
                .sort()
                .reverse();
            return { data: { versions } };
        },
    });

    const restore = defineTool({
        name: "skills_restore_version",
        label: "Restore a skill version",
        description: "Put an earlier version of a skill back. The version it replaces is kept too.",
        effect: "draft",
        parameters: Type.Object({ name: Type.String(), version: Type.String() }),
        execute: async (params, context) => {
            const folder = folderOf(params.name);
            if (!/^[\w-]+$/.test(params.version)) throw new Error("Unknown version");
            const sandbox = await sandboxes.forUser(context.userId);
            const old = await sandbox.readFile(`${folder}/${HISTORY}/${params.version}.md`);
            if (old === undefined) throw new Error(`No version ${params.version} of ${params.name}`);
            await keepVersion(context.userId, folder);
            await sandbox.writeFile(`${folder}/SKILL.md`, old);
            return { data: { restored: params.version } };
        },
    });

    return {
        id: "skills",
        summary: "Save what you learn as skills on your computer, and undo changes to them.",
        skill: promptFile(import.meta.url, "SKILL.md"),
        tools: [save, listVersions, restore],
    };
};
