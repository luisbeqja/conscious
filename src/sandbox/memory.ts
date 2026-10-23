import type { Sandbox } from "./sandbox.js";

/** Where memory lived before the memory tools: free notes the agent wrote itself. */
export const OLDER_NOTES = "memory/MEMORY.md";
const MAX_NOTES_CHARS = 6_000;

/** The free-form notes from before the memory tools, so nothing a user told Conscious is lost. */
export const loadOlderNotes = async (sandbox: Sandbox): Promise<string | undefined> => {
    const notes = (await sandbox.readFile(OLDER_NOTES))?.trim();
    if (!notes) return undefined;
    if (notes.length <= MAX_NOTES_CHARS) return notes;
    return `${notes.slice(0, MAX_NOTES_CHARS)}\n…(cut: ${OLDER_NOTES} is too long, move its facts into memory)`;
};
