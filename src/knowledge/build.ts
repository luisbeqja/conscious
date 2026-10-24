import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chunkMarkdown, plain, terms } from "./chunk.js";
import { type Embedder, EmbeddingsError } from "./embeddings.js";
import type { KnowledgeDocument } from "./store.js";

export interface BuildOptions {
    /** Without one, the index searches by keywords only. */
    embedder?: Embedder;
    /** An index built before: passages whose text did not change keep their vectors. */
    previous?: string;
    /** Texts per embeddings request. */
    batchSize?: number;
    onProgress?: (embedded: number, total: number) => void;
}

export interface BuildStats {
    documents: number;
    chunks: number;
    embedded: number;
    reused: number;
}

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE documents (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, authority TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL,
    source TEXT NOT NULL, page_date TEXT, downloaded TEXT NOT NULL, text TEXT NOT NULL
);
CREATE TABLE chunks (
    id INTEGER PRIMARY KEY, doc_id TEXT NOT NULL, heading TEXT NOT NULL, start INTEGER NOT NULL,
    text TEXT NOT NULL, hash TEXT NOT NULL, vector BLOB
);
CREATE VIRTUAL TABLE chunks_fts USING fts5(title, heading, body, content='', tokenize='unicode61 remove_diacritics 2');
`;

/** What a passage is embedded and indexed as: its page and headings first, then its words. */
export const passageText = (document: KnowledgeDocument, heading: string, text: string): string =>
    [`${document.title} (${document.authority})`, heading, plain(text)].filter(Boolean).join("\n").slice(0, 2000);

/**
 * Writes a search index for `documents` into one SQLite file: the documents, their passages,
 * a keyword index over the passages and, with an embedder, one vector per passage.
 * The file is replaced only once it is complete. A build that fails keeps what it embedded,
 * and the next one starts from there.
 */
export const buildIndex = async (
    file: string,
    documents: readonly KnowledgeDocument[],
    options: BuildOptions = {},
): Promise<BuildStats> => {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.building`;
    const partial = `${file}.partial`;
    if (existsSync(temporary)) renameSync(temporary, partial);
    // A journal left by a crash would otherwise be replayed into the new file.
    rmSync(`${temporary}-journal`, { force: true });
    const model = options.embedder?.model ?? "";
    const db = new DatabaseSync(temporary);
    try {
        db.exec("PRAGMA synchronous = OFF");
        db.exec(SCHEMA);
        db.prepare("INSERT INTO meta (key, value) VALUES ('model', ?)").run(model);
        const passages = insertDocuments(db, documents, model);
        let embedded = 0;
        let reused = 0;
        if (options.embedder) {
            const embedder = options.embedder;
            const cached = new Map([
                ...previousVectors(partial, model),
                ...(options.previous ? previousVectors(options.previous, model) : []),
            ]);
            const setVector = db.prepare("UPDATE chunks SET vector = ? WHERE id = ?");
            db.exec("BEGIN");
            const missing = passages.filter((passage) => {
                const vector = cached.get(passage.hash);
                if (vector) setVector.run(vector, passage.id);
                return !vector;
            });
            db.exec("COMMIT");
            reused = passages.length - missing.length;
            const batchSize = options.batchSize ?? 32;
            for (let at = 0; at < missing.length; at += batchSize) {
                const batch = missing.slice(at, at + batchSize);
                const vectors = await embedInHalves(
                    embedder,
                    batch.map((passage) => passage.text),
                );
                db.exec("BEGIN");
                batch.forEach((passage, index) => {
                    const vector = vectors[index] as Float32Array;
                    setVector.run(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), passage.id);
                });
                db.exec("COMMIT");
                embedded += batch.length;
                options.onProgress?.(embedded, missing.length);
            }
        }
        db.prepare("INSERT INTO meta (key, value) VALUES ('built', ?)").run(new Date().toISOString());
        db.exec("INSERT INTO chunks_fts (chunks_fts) VALUES ('optimize')");
        db.close();
        renameSync(temporary, file);
        rmSync(partial, { force: true });
        return { documents: documents.length, chunks: passages.length, embedded, reused };
    } catch (error) {
        // Each batch was committed, so the half-built file holds every vector paid for so far.
        if (db.isOpen) db.close();
        throw error;
    }
};

/** One request per batch; a batch the service finds too big goes again in halves. */
const embedInHalves = async (embedder: Embedder, texts: string[]): Promise<Float32Array[]> => {
    try {
        return await embedder.embed(texts);
    } catch (error) {
        if (texts.length < 2 || !(error instanceof EmbeddingsError) || ![400, 413, 422].includes(error.status)) {
            throw error;
        }
        const half = Math.ceil(texts.length / 2);
        return [
            ...(await embedInHalves(embedder, texts.slice(0, half))),
            ...(await embedInHalves(embedder, texts.slice(half))),
        ];
    }
};

const insertDocuments = (db: DatabaseSync, documents: readonly KnowledgeDocument[], model: string) => {
    const addDocument = db.prepare(
        "INSERT INTO documents (id, title, authority, scope, kind, source, page_date, downloaded, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const addChunk = db.prepare("INSERT INTO chunks (doc_id, heading, start, text, hash) VALUES (?, ?, ?, ?, ?)");
    const addTerms = db.prepare("INSERT INTO chunks_fts (rowid, title, heading, body) VALUES (?, ?, ?, ?)");
    const passages: { id: number; text: string; hash: string }[] = [];
    db.exec("BEGIN");
    for (const document of documents) {
        addDocument.run(
            document.id,
            document.title,
            document.authority,
            document.scope,
            document.kind,
            document.source,
            document.pageDate ?? null,
            document.downloaded,
            document.text,
        );
        const title = terms(`${document.title} ${document.authority}`).join(" ");
        for (const chunk of chunkMarkdown(document.text)) {
            const text = passageText(document, chunk.heading, chunk.text);
            const hash = createHash("sha1").update(`${model}\n${text}`).digest("hex");
            const { lastInsertRowid } = addChunk.run(document.id, chunk.heading, chunk.offset, chunk.text, hash);
            const id = Number(lastInsertRowid);
            addTerms.run(id, title, terms(chunk.heading).join(" "), terms(plain(chunk.text)).join(" "));
            passages.push({ id, text, hash });
        }
    }
    db.exec("COMMIT");
    return passages;
};

/** The vectors of an earlier or half-built index, by passage hash, when made by the same model. */
const previousVectors = (file: string, model: string): Map<string, Uint8Array> => {
    if (!model || !existsSync(file)) return new Map();
    let db: DatabaseSync | undefined;
    try {
        db = new DatabaseSync(file, { readOnly: true });
        const built = db.prepare("SELECT value FROM meta WHERE key = 'model'").get() as { value: string } | undefined;
        if (built?.value !== model) return new Map();
        const rows = db.prepare("SELECT hash, vector FROM chunks WHERE vector IS NOT NULL").all() as {
            hash: string;
            vector: Uint8Array;
        }[];
        return new Map(rows.map((row) => [row.hash, row.vector]));
    } catch {
        // A file cut off by a crash is only a cache: start without it.
        return new Map();
    } finally {
        db?.close();
    }
};
