import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Reads a markdown file next to the calling module. Prompts live as files so they diff like prose. */
export const promptFile = (moduleUrl: string, name: string): string =>
    readFileSync(join(dirname(fileURLToPath(moduleUrl)), name), "utf8").trim();
