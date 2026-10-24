import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { buildIndex } from "../src/knowledge/build.js";
import { createEmbedder } from "../src/knowledge/embeddings.js";
import type { KnowledgeDocument } from "../src/knowledge/store.js";

// Builds the search index of official Italian pages from what `pnpm italy:download` saved.
//   pnpm italy:index [--from <download folder>] [--to <index file>]
// It reads .conscious/italy/download and writes CONSCIOUS_ITALY_INDEX (default .conscious/italy/index.sqlite),
// embedded with CONSCIOUS_EMBEDDINGS. A rebuild embeds only the passages that changed.

const { values } = parseArgs({
    options: { from: { type: "string" }, to: { type: "string" } },
});
const config = loadConfig();
const from = values.from ?? join(config.dataDir, "italy", "download");
const to = values.to ?? config.italyIndex;

/** One document per page the downloader saved, with the metadata of its frontmatter. */
const readDownload = (folder: string): KnowledgeDocument[] => {
    const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as {
        url: string;
        file: string | null;
    }[];
    const files = new Map(manifest.filter((entry) => entry.file).map((entry) => [entry.url, entry.file as string]));
    return [...files].map(([url, file]) => {
        const markdown = readFileSync(join(folder, file), "utf8");
        const end = markdown.indexOf("\n---\n", 4);
        const meta: Record<string, string> = Object.fromEntries(
            markdown
                .slice(4, end)
                .split("\n")
                .map((line) => [line.slice(0, line.indexOf(": ")), JSON.parse(line.slice(line.indexOf(": ") + 2))]),
        );
        return {
            id: createHash("sha1").update(url).digest("hex").slice(0, 12),
            title: meta.title ?? "",
            authority: meta.authority ?? "",
            scope: meta.scope ?? "",
            kind: meta.kind ?? "page",
            source: meta.source ?? url,
            ...(meta.page_date ? { pageDate: meta.page_date } : {}),
            downloaded: meta.downloaded ?? "",
            text: markdown.slice(end + 5).trim(),
        };
    });
};

if (!existsSync(join(from, "manifest.json"))) {
    console.error(`No download in ${from}. Run: pnpm italy:download --out ${from}`);
    process.exit(1);
}
const documents = readDownload(from);
const embedder = config.embeddings ? createEmbedder(config.embeddings) : undefined;
console.log(
    `${documents.length} pages from ${from}, ${embedder ? `embedded with ${embedder.model} (${config.embeddings?.provider})` : "keywords only: no CONSCIOUS_EMBEDDINGS"}`,
);
const started = Date.now();
let reported = 0;
const stats = await buildIndex(to, documents, {
    embedder,
    previous: to,
    onProgress: (done, total) => {
        if (done === total || done - reported >= total / 10) {
            reported = done;
            console.log(`  embedded ${done}/${total} passages`);
        }
    },
});
const megabytes = (statSync(to).size / 1e6).toFixed(0);
console.log(
    `${stats.chunks} passages, ${stats.embedded} embedded, ${stats.reused} reused, in ${((Date.now() - started) / 60_000).toFixed(1)} min. Index: ${to} (${megabytes} MB)`,
);
