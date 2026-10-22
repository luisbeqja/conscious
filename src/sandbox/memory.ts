import type { Sandbox } from "./sandbox.js";

export const MEMORY_INDEX = "memory/MEMORY.md";
// The index is read into every prompt; past this it should point to files, not hold the facts.
const MAX_MEMORY_CHARS = 6_000;

/** What Conscious remembers about the user, read from their sandbox for the system prompt. */
export const loadMemory = async (sandbox: Sandbox): Promise<string> => {
    const index = (await sandbox.readFile(MEMORY_INDEX))?.trim();
    if (!index) return "Nothing yet.";
    if (index.length <= MAX_MEMORY_CHARS) return index;
    return `${index.slice(0, MAX_MEMORY_CHARS)}\n…(cut: ${MEMORY_INDEX} is too long, move details into their own files)`;
};
