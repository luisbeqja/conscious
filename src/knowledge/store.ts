import { DatabaseSync } from "node:sqlite";
import { plain, terms } from "./chunk.js";
import type { Embedder } from "./embeddings.js";

export interface KnowledgeDocument {
    /** Stable across rebuilds: made from the source address. */
    id: string;
    title: string;
    /** The office that publishes the page, such as "INPS" or "Comune di Bergamo". */
    authority: string;
    /** nazionale, regionale, comunale or europea. */
    scope: string;
    /** "page", or "portal" for a page that mostly links to services. */
    kind: string;
    /** Where the page came from, so the current version can be checked. */
    source: string;
    /** The date the page itself shows, when it shows one. */
    pageDate?: string;
    /** When this copy was saved. */
    downloaded: string;
    /** The page as Markdown. */
    text: string;
}

export type DocumentInfo = Omit<KnowledgeDocument, "text"> & { chars: number };

/** A passage that matched, and where it starts, to read on from there. */
export interface Match {
    heading: string;
    offset: number;
    text: string;
}

export interface SearchHit extends DocumentInfo {
    matches: Match[];
    /**
     * How much of the query the page's best passage, headings and title contain, from 0 to 1. Rare
     * words weigh more, so "TARI" or "monopattino" decides it rather than "contributo".
     */
    coverage: number;
}

export interface SearchOptions {
    limit?: number;
    /** Only documents whose authority contains this, ignoring case and accents: "Bergamo", "Lombardia". */
    authority?: string;
    scope?: string;
    /** One ranking alone, to compare them. Default both. */
    mode?: "hybrid" | "keywords" | "vectors";
    signal?: AbortSignal;
}

interface Passage {
    doc: number;
    heading: string;
    start: number;
}

/** How long a search waits for the query's vector before it goes on with keywords alone. */
const EMBED_TIMEOUT_MS = 10_000;
/** Passages each ranking hands to the fusion. */
const CANDIDATES = 200;
/** Reciprocal rank fusion's constant: how much a first place outweighs a tenth. */
const RRF_K = 60;
/**
 * How much the keyword ranking counts next to the vector one. Measured on 57 questions about
 * the Italian pages: words alone put the right page first for 0 of 9 English questions and
 * 26 of 36 Italian ones; vectors for 4 and 31; both, with words at 0.3, for 5 and 33.
 */
const KEYWORD_WEIGHT = 0.3;
const SNIPPET_CHARS = 320;

const fold = (text: string) => terms(text).join(" ");

/** An address without what does not change the page: scheme, www, trailing slash, fragment. */
const addressKey = (url: string): string =>
    url
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\/(www\.)?/, "")
        .replace(/#.*$/, "")
        .replace(/\/$/, "");

/**
 * A search index built by `buildIndex`: keyword search (BM25) over every passage and, when the
 * embedder is the model that built the index, vector search too, fused by rank. Results are
 * documents, with the passages that matched, so the reader can open the whole page next.
 */
export class KnowledgeIndex {
    private vectors?: { ids: Int32Array; values: Float32Array; dims: number };
    private readonly position: Map<string, number>;
    /** How many passages contain a word, by word, as searches ask. */
    private readonly frequencies = new Map<string, number>();
    private readonly addresses: Map<string, number>;
    /** Each document's authority, folded like a query, for the place filter. */
    private readonly authorities: string[];

    private constructor(
        private readonly db: DatabaseSync,
        private readonly docs: DocumentInfo[],
        private readonly passages: Map<number, Passage>,
        /** The embeddings model that built the index; empty for a keyword-only index. */
        readonly model: string,
        private readonly embedder?: Embedder,
    ) {
        this.position = new Map(docs.map((doc, index) => [doc.id, index]));
        this.addresses = new Map(docs.map((doc, index) => [addressKey(doc.source), index]));
        this.authorities = docs.map((doc) => fold(doc.authority));
    }

    static open(file: string, embedder?: Embedder): KnowledgeIndex {
        const db = new DatabaseSync(file, { readOnly: true });
        const docs = (
            db
                .prepare(
                    "SELECT id, title, authority, scope, kind, source, page_date, downloaded, length(text) AS chars FROM documents ORDER BY rowid",
                )
                .all() as {
                id: string;
                title: string;
                authority: string;
                scope: string;
                kind: string;
                source: string;
                page_date: string | null;
                downloaded: string;
                chars: number;
            }[]
        ).map(({ page_date, ...doc }) => ({ ...doc, ...(page_date ? { pageDate: page_date } : {}) }));
        const position = new Map(docs.map((doc, index) => [doc.id, index]));
        const passages = new Map<number, Passage>();
        for (const row of db.prepare("SELECT id, doc_id, heading, start FROM chunks").iterate() as Iterable<{
            id: number;
            doc_id: string;
            heading: string;
            start: number;
        }>) {
            passages.set(row.id, { doc: position.get(row.doc_id) ?? -1, heading: row.heading, start: row.start });
        }
        const model = (db.prepare("SELECT value FROM meta WHERE key = 'model'").get() as { value: string } | undefined)
            ?.value;
        return new KnowledgeIndex(db, docs, passages, model ?? "", embedder);
    }

    /** True when searches compare meanings too, not only words. */
    get semantic(): boolean {
        return Boolean(this.model && this.embedder?.model === this.model);
    }

    get size(): number {
        return this.docs.length;
    }

    async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
        const mode = options.mode ?? "hybrid";
        const place = options.authority ? fold(options.authority) : "";
        const filtered = Boolean(place || options.scope);
        const allowed = (doc: number): boolean => {
            if (doc < 0) return false;
            if (!filtered) return true;
            if (options.scope && this.docs[doc]?.scope !== options.scope) return false;
            return !place || Boolean(this.authorities[doc]?.includes(place));
        };
        const words = [...new Set(terms(query, true))];
        const rankings: { ids: number[]; weight: number }[] = [];
        if (mode !== "vectors")
            rankings.push({ ids: this.keywordRanking(words, allowed, filtered), weight: KEYWORD_WEIGHT });
        if (mode !== "keywords" && this.semantic) {
            try {
                rankings.push({ ids: await this.vectorRanking(query, allowed, options.signal), weight: 1 });
            } catch (error) {
                // Keywords alone still find most pages; a failed embeddings call should not fail the search.
                console.warn(`[knowledge] vector search skipped: ${(error as Error).message}`);
            }
        }
        const fused = new Map<number, number>();
        for (const { ids, weight } of rankings) {
            for (const [rank, id] of ids.entries()) fused.set(id, (fused.get(id) ?? 0) + weight / (RRF_K + rank + 1));
        }
        const byDoc = new Map<number, { id: number; score: number }[]>();
        for (const [id, score] of fused) {
            const doc = this.passages.get(id)?.doc ?? -1;
            if (doc < 0) continue;
            const list = byDoc.get(doc) ?? [];
            list.push({ id, score });
            byDoc.set(doc, list);
        }
        // A page is as good as its best passage: counting more passages would favour long pages.
        const ranked = [...byDoc.entries()]
            .map(([doc, hits]) => {
                hits.sort((a, b) => b.score - a.score);
                return { doc, hits, score: hits[0]?.score ?? 0 };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, options.limit ?? 5);
        const text = this.db.prepare("SELECT text FROM chunks WHERE id = ?");
        const weights = words.map((word) => Math.log((this.passages.size + 1) / (this.frequency(word) + 1)));
        const total = weights.reduce((sum, weight) => sum + weight, 0);
        const coverage = (info: DocumentInfo, passage: Passage, body: string): number => {
            if (!total) return 1;
            const found = new Set(terms(`${info.title} ${info.authority} ${passage.heading} ${plain(body)}`));
            return words.reduce((sum, word, index) => sum + (found.has(word) ? (weights[index] ?? 0) : 0), 0) / total;
        };
        return ranked.map(({ doc, hits }) => ({
            ...(this.docs[doc] as DocumentInfo),
            coverage: Math.max(
                ...hits.slice(0, 2).map((hit) => {
                    const row = text.get(hit.id) as { text: string };
                    return coverage(this.docs[doc] as DocumentInfo, this.passages.get(hit.id) as Passage, row.text);
                }),
            ),
            // Pages that repeat a block (tabs, print versions) would show it twice.
            matches: hits
                .slice(0, 3)
                .map((hit) => {
                    const passage = this.passages.get(hit.id) as Passage;
                    const row = text.get(hit.id) as { text: string };
                    return { heading: passage.heading, offset: passage.start, text: snippet(row.text, words) };
                })
                .filter((match, index, all) => all.findIndex((other) => other.text === match.text) === index)
                .slice(0, 2),
        }));
    }

    /** A document by its id, or by its source address. */
    read(idOrAddress: string): KnowledgeDocument | undefined {
        const info = this.docs[this.position.get(idOrAddress) ?? this.addresses.get(addressKey(idOrAddress)) ?? -1];
        if (!info) return undefined;
        const row = this.db.prepare("SELECT text FROM documents WHERE id = ?").get(info.id) as { text: string };
        const { chars, ...rest } = info;
        return { ...rest, text: row.text };
    }

    close(): void {
        this.db.close();
    }

    /** In how many passages a folded word appears. */
    private frequency(word: string): number {
        let count = this.frequencies.get(word);
        if (count === undefined) {
            const row = this.db
                .prepare("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?")
                .get(`"${word}"`);
            count = (row as { n: number }).n;
            this.frequencies.set(word, count);
        }
        return count;
    }

    /** Passage ids by BM25 over the page title, the headings and the passage, in that order of weight. */
    private keywordRanking(words: readonly string[], allowed: (doc: number) => boolean, filtered: boolean): number[] {
        if (!words.length) return [];
        const rows = this.db
            .prepare(
                "SELECT rowid AS id FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts, 4.0, 2.0, 1.0) LIMIT ?",
            )
            .all(words.map((word) => `"${word}"`).join(" OR "), filtered ? 20 * CANDIDATES : CANDIDATES) as {
            id: number;
        }[];
        return rows
            .map((row) => row.id)
            .filter((id) => allowed(this.passages.get(id)?.doc ?? -1))
            .slice(0, CANDIDATES);
    }

    /** Passage ids by the cosine between their vector and the query's. */
    private async vectorRanking(
        query: string,
        allowed: (doc: number) => boolean,
        signal?: AbortSignal,
    ): Promise<number[]> {
        const deadline = AbortSignal.any([AbortSignal.timeout(EMBED_TIMEOUT_MS), ...(signal ? [signal] : [])]);
        const [vector] = (await this.embedder?.embed([query], deadline)) ?? [];
        if (!vector) return [];
        const { ids, values, dims } = this.loadVectors();
        if (vector.length !== dims) throw new Error(`the query has ${vector.length} dimensions, the index ${dims}`);
        const scored: { id: number; score: number }[] = [];
        for (let row = 0; row < ids.length; row++) {
            const id = ids[row] as number;
            if (!allowed(this.passages.get(id)?.doc ?? -1)) continue;
            let score = 0;
            const base = row * dims;
            for (let index = 0; index < dims; index++) {
                score += (vector[index] as number) * (values[base + index] as number);
            }
            scored.push({ id, score });
        }
        return scored
            .sort((a, b) => b.score - a.score)
            .slice(0, CANDIDATES)
            .map((entry) => entry.id);
    }

    /** All passage vectors in one array, read on the first vector search. */
    private loadVectors(): { ids: Int32Array; values: Float32Array; dims: number } {
        if (this.vectors) return this.vectors;
        const count = (
            this.db.prepare("SELECT count(*) AS n FROM chunks WHERE vector IS NOT NULL").get() as { n: number }
        ).n;
        let dims = 0;
        let ids = new Int32Array(0);
        let values = new Float32Array(0);
        let row = 0;
        for (const { id, vector } of this.db
            .prepare("SELECT id, vector FROM chunks WHERE vector IS NOT NULL ORDER BY id")
            .iterate() as Iterable<{ id: number; vector: Uint8Array }>) {
            if (!dims) {
                dims = vector.byteLength / 4;
                ids = new Int32Array(count);
                values = new Float32Array(count * dims);
            }
            ids[row] = id;
            // A copy, because a Float32Array needs its bytes aligned to 4.
            values.set(new Float32Array(vector.slice().buffer), row * dims);
            row++;
        }
        this.vectors = { ids, values, dims };
        return this.vectors;
    }
}

/** A passage as plain words: the part around the first query word in it, or its start. */
const snippet = (markdown: string, words: readonly string[]): string => {
    const text = plain(markdown).normalize("NFC");
    if (text.length <= SNIPPET_CHARS) return text;
    // Folding keeps the length of NFC text, so a position in it is a position in the text.
    const folded = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    const found = words
        .map((word) => folded.search(new RegExp(`\\b${word}`)))
        .filter((at) => at >= 0)
        .sort((a, b) => a - b)[0];
    // Start a little before the word, at a space, but no later than a full window from the end.
    const lastWindow = text.lastIndexOf(" ", text.length - SNIPPET_CHARS) + 1;
    const start = Math.min(found && found > 60 ? text.indexOf(" ", found - 60) + 1 : 0, lastWindow);
    const space = text.lastIndexOf(" ", start + SNIPPET_CHARS);
    const end = start + SNIPPET_CHARS >= text.length ? text.length : space > start ? space : start + SNIPPET_CHARS;
    return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
};
