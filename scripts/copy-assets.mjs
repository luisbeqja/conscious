import { cpSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Prompts, skills and the plugin sandbox runner are read at runtime, so the build copies them beside the compiled code.
const copy = (dir) => {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) copy(path);
        else if (name.endsWith(".md") || name.endsWith(".mjs")) cpSync(path, path.replace(/^src/, "dist"));
    }
};
copy("src");
