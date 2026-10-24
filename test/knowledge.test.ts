import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createItalyCapability } from "../src/capabilities/italy/capability.js";
import type { ToolContext } from "../src/capabilities/types.js";
import { buildIndex } from "../src/knowledge/build.js";
import { chunkMarkdown, terms } from "../src/knowledge/chunk.js";
import { createEmbedder, type Embedder, EmbeddingsError } from "../src/knowledge/embeddings.js";
import { type KnowledgeDocument, KnowledgeIndex } from "../src/knowledge/store.js";
import { Scheduler } from "../src/scheduler/scheduler.js";

const context: ToolContext = { userId: "u1", timezone: "Europe/Rome", scheduler: new Scheduler(async () => {}) };

const page = (
    fields: Partial<KnowledgeDocument> & Pick<KnowledgeDocument, "id" | "title" | "authority" | "text">,
): KnowledgeDocument => ({
    scope: "nazionale",
    kind: "page",
    source: `https://example.gov.it/${fields.id}`,
    downloaded: "2026-10-24",
    ...fields,
});

const PAGES: KnowledgeDocument[] = [
    page({
        id: "passaporto",
        title: "Passaporto per minori",
        authority: "Polizia di Stato",
        text: "# Passaporto per minori\n\nIl passaporto del figlio minorenne si chiede in questura, con l'assenso di entrambi i genitori.\n\n## Costi\n\nIl contributo è di 42,50 euro.",
    }),
    page({
        id: "naspi",
        title: "NASpI: indennità di disoccupazione",
        authority: "INPS",
        pageDate: "2026-03-01",
        text: "# NASpI\n\nLa NASpI è l'indennità mensile di disoccupazione per chi ha perso il lavoro.\n\n## Domanda\n\nLa domanda si presenta online entro 68 giorni.",
    }),
    page({
        id: "residenza-bg",
        title: "Dichiarazione di residenza a Bergamo",
        authority: "Comune di Bergamo",
        scope: "comunale",
        text: "# Dichiarazione di residenza a Bergamo\n\nPer cambiare residenza a Bergamo si compila il modulo ministeriale.",
    }),
    page({
        id: "residenza-na",
        title: "Cambio di residenza a Napoli",
        authority: "Comune di Napoli",
        scope: "comunale",
        text: "# Cambio di residenza a Napoli\n\nIl cambio di residenza a Napoli si chiede all'anagrafe.",
    }),
];

/** Meanings as dimensions: words that mean the same thing, in either language, share one. */
const CONCEPTS: Record<string, number> = {
    passport: 0,
    passaporto: 0,
    child: 1,
    figlio: 1,
    minori: 1,
    unemployment: 2,
    disoccupazione: 2,
    lavoro: 2,
    residence: 3,
    residenza: 3,
};

const fakeEmbedder = (model = "fake-1", calls: string[][] = []): Embedder => ({
    model,
    embed: async (texts) => {
        calls.push([...texts]);
        return texts.map((text) => {
            const vector = new Float32Array(5).fill(0.01);
            for (const word of text.toLowerCase().split(/[^a-zà-ù]+/)) {
                const dimension = CONCEPTS[word];
                if (dimension !== undefined) vector[dimension] = (vector[dimension] ?? 0) + 1;
            }
            const length = Math.hypot(...vector);
            return vector.map((value) => value / length);
        });
    },
});

const folders: string[] = [];
const indexes: KnowledgeIndex[] = [];
afterEach(() => {
    for (const index of indexes.splice(0)) index.close();
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const indexFile = () => {
    const folder = mkdtempSync(join(tmpdir(), "knowledge-"));
    folders.push(folder);
    return join(folder, "index.sqlite");
};

const built = async (embedder: Embedder | undefined, documents = PAGES) => {
    const file = indexFile();
    await buildIndex(file, documents, { embedder });
    const index = KnowledgeIndex.open(file, embedder);
    indexes.push(index);
    return index;
};

describe("chunkMarkdown", () => {
    it("starts a passage at a heading, keeps the headings above it and where it starts", () => {
        const text = `# Titolo\n\nIntro breve.\n\n## Requisiti\n\n${"Serve un documento valido. ".repeat(30)}\n\n## Costi\n\nDieci euro.`;
        const chunks = chunkMarkdown(text, 500);

        expect(chunks.length).toBeGreaterThan(2);
        for (const chunk of chunks) {
            expect(chunk.text.length).toBeLessThanOrEqual(500);
            expect(text.slice(chunk.offset).startsWith(chunk.text.split("\n")[0] as string)).toBe(true);
        }
        // A short section joins the next one instead of standing alone.
        expect(chunks[0]?.text).toContain("## Requisiti");
        expect(chunks.at(-1)?.heading).toBe("Titolo › Costi");
    });
});

describe("terms", () => {
    it("folds accents and Italian endings, so related words match", () => {
        expect(terms("Rinnovo rinnovare rinnovata")).toEqual(["rinnov", "rinnov", "rinnov"]);
        expect(terms("Carte d'identità")).toEqual(["cart", "d", "identit"]);
        expect(terms("Come si rinnova la carta?", true)).toEqual(["rinnov", "cart"]);
    });
});

describe("knowledge index", () => {
    it("finds a page from a question in another language, which keywords alone miss", async () => {
        const index = await built(fakeEmbedder());

        expect(index.semantic).toBe(true);
        expect((await index.search("passport for my child"))[0]?.id).toBe("passaporto");
        expect((await index.search("passport for my child", { mode: "keywords" })).map((hit) => hit.id)).toEqual([]);
    });

    it("gives each page its source, dates and the passages that matched, with where to read from", async () => {
        const index = await built(fakeEmbedder());
        const [hit] = await index.search("disoccupazione");

        expect(hit).toMatchObject({
            id: "naspi",
            authority: "INPS",
            source: "https://example.gov.it/naspi",
            pageDate: "2026-03-01",
            downloaded: "2026-10-24",
        });
        const match = hit?.matches[0];
        expect(match?.text).toContain("disoccupazione");
        expect(index.read("naspi")?.text.slice(match?.offset)).toMatch(/^# NASpI/);
    });

    it("shows the part of a long passage where the query's words are", async () => {
        const text = `# Bonus\n\n${"Il bonus spetta alle famiglie con figli piccoli. ".repeat(14)}La scadenza è il 31 dicembre.`;
        const index = await built(undefined, [page({ id: "bonus", title: "Bonus", authority: "INPS", text })]);
        const [match] = (await index.search("scadenza"))[0]?.matches ?? [];

        expect(match?.text).toMatch(/^….*La scadenza è il 31 dicembre\.$/);
        expect(match?.offset).toBe(0);
    });

    it("opens a page by its source address too, as a link in another page gives it", async () => {
        const index = await built(fakeEmbedder());

        expect(index.read("http://example.gov.it/naspi/#domanda")?.id).toBe("naspi");
        expect(index.read("https://example.gov.it/altro")).toBeUndefined();
    });

    it("keeps to one place, or one scope, when asked", async () => {
        const index = await built(fakeEmbedder());

        // Vectors rank every page, so the closest ones come first and the rest follow.
        expect((await index.search("residenza", { limit: 2 })).map((hit) => hit.id).sort()).toEqual([
            "residenza-bg",
            "residenza-na",
        ]);
        expect((await index.search("residenza", { authority: "bergamo" })).map((hit) => hit.id)).toEqual([
            "residenza-bg",
        ]);
        const national = await index.search("residenza", { scope: "nazionale" });
        expect(national.length).toBeGreaterThan(0);
        expect(national.every((hit) => hit.scope === "nazionale")).toBe(true);
    });

    it("searches by keywords only when another model built the index", async () => {
        const file = indexFile();
        await buildIndex(file, PAGES, { embedder: fakeEmbedder("fake-1") });
        const calls: string[][] = [];
        const index = KnowledgeIndex.open(file, fakeEmbedder("fake-2", calls));
        indexes.push(index);

        expect(index.semantic).toBe(false);
        expect((await index.search("disoccupazione"))[0]?.id).toBe("naspi");
        expect(calls).toEqual([]);
    });

    it("still answers by keywords when the embeddings service fails", async () => {
        const file = indexFile();
        await buildIndex(file, PAGES, { embedder: fakeEmbedder() });
        const broken: Embedder = {
            model: "fake-1",
            embed: async () => {
                throw new Error("HTTP 503");
            },
        };
        const index = KnowledgeIndex.open(file, broken);
        indexes.push(index);

        expect((await index.search("disoccupazione"))[0]?.id).toBe("naspi");
    });

    it("embeds again only the passages that changed", async () => {
        const file = indexFile();
        await buildIndex(file, PAGES, { embedder: fakeEmbedder() });
        const calls: string[][] = [];
        const changed = PAGES.map((doc) =>
            doc.id === "naspi" ? { ...doc, text: "# NASpI\n\nLa domanda si presenta entro 68 giorni." } : doc,
        );
        const stats = await buildIndex(file, changed, { embedder: fakeEmbedder("fake-1", calls), previous: file });

        expect(stats.embedded).toBe(1);
        expect(stats.reused).toBe(stats.chunks - 1);
        expect(calls.flat()).toHaveLength(1);
    });

    it("keeps what a failed build embedded, and starts the next one from there", async () => {
        const file = indexFile();
        let calls = 0;
        const flaky: Embedder = {
            model: "fake-1",
            embed: async (texts) => {
                if (++calls > 1) throw new Error("HTTP 401");
                return fakeEmbedder().embed(texts);
            },
        };
        await expect(buildIndex(file, PAGES, { embedder: flaky, batchSize: 2 })).rejects.toThrow("HTTP 401");
        expect(existsSync(file)).toBe(false);

        const stats = await buildIndex(file, PAGES, { embedder: fakeEmbedder(), batchSize: 2 });
        expect(stats.reused).toBe(2);
        expect(stats.embedded).toBe(stats.chunks - 2);
        expect(existsSync(`${file}.partial`)).toBe(false);
    });

    it("sends a batch the service finds too big again in halves", async () => {
        const sizes: number[] = [];
        const picky: Embedder = {
            model: "fake-1",
            embed: async (texts) => {
                sizes.push(texts.length);
                if (texts.length > 2) throw new EmbeddingsError("too many tokens", 400);
                return fakeEmbedder().embed(texts);
            },
        };
        const stats = await buildIndex(indexFile(), PAGES, { embedder: picky, batchSize: 4 });

        expect(stats.embedded).toBe(stats.chunks);
        expect(sizes.slice(0, 3)).toEqual([4, 2, 2]);
    });

    it("builds a keyword-only index without an embedder", async () => {
        const index = await built(undefined);

        expect(index.model).toBe("");
        expect((await index.search("modulo ministeriale"))[0]?.id).toBe("residenza-bg");
    });
});

describe("italy capability", () => {
    const tool = (capability: ReturnType<typeof createItalyCapability>, name: string) => {
        const found = capability.tools.find((candidate) => candidate.name === name);
        if (!found) throw new Error(name);
        return found;
    };

    it("searches and reads official pages, always with their source address", async () => {
        const italy = createItalyCapability(await built(fakeEmbedder()));
        expect(italy.tools.map((candidate) => [candidate.name, candidate.effect])).toEqual([
            ["italy_search_pages", "read"],
            ["italy_read_page", "read"],
        ]);

        const found = await tool(italy, "italy_search_pages").execute({ query: "chi ha perso il lavoro" }, context);
        const results = (found.data as { results: { id: string; source: string; matches: unknown[] }[] }).results;
        expect(results[0]).toMatchObject({ id: "naspi", source: "https://example.gov.it/naspi" });
        expect(results[0]?.matches.length).toBeGreaterThan(0);
        expect(found.guidance).toContain("italy_read_page");

        const read = await tool(italy, "italy_read_page").execute({ id: "naspi" }, context);
        expect(read.data).toMatchObject({ source: "https://example.gov.it/naspi", downloaded: "2026-10-24" });
        expect((read.data as { text: string }).text).toContain("68 giorni");
        expect(read.guidance).toContain("https://example.gov.it/naspi");
    });

    it("reads a long page in parts and says when an id is unknown", async () => {
        const long = page({ id: "lungo", title: "Pagina lunga", authority: "INPS", text: "parola ".repeat(400) });
        const italy = createItalyCapability(await built(fakeEmbedder(), [long]));
        const read = tool(italy, "italy_read_page");

        const first = (await read.execute({ id: "lungo", maxChars: 500 }, context)).data as Record<string, unknown>;
        expect(first).toMatchObject({ totalChars: 2800, nextOffset: 500 });
        const last = (await read.execute({ id: "lungo", offset: 2500, maxChars: 500 }, context)).data;
        expect(last).not.toHaveProperty("nextOffset");
        expect((await read.execute({ id: "nope" }, context)).data).toHaveProperty("error");
    });
});

describe("createEmbedder", () => {
    it("asks an OpenAI-style API and returns unit vectors in the order of the input", async () => {
        let url = "";
        let body: unknown;
        let auth: string | undefined;
        const fakeFetch = (async (input: string, init?: RequestInit) => {
            url = input;
            body = JSON.parse(init?.body as string);
            auth = (init?.headers as Record<string, string>).authorization;
            return Response.json({
                data: [
                    { index: 1, embedding: [0, 2] },
                    { index: 0, embedding: [3, 4] },
                ],
            });
        }) as typeof fetch;
        const embedder = createEmbedder(
            { provider: "mistral", baseUrl: "https://api.mistral.ai/v1/", model: "mistral-embed", apiKey: "k" },
            fakeFetch,
        );

        const [first, second] = await embedder.embed(["a", "b"]);
        expect([...(first ?? [])]).toEqual([expect.closeTo(0.6), expect.closeTo(0.8)]);
        expect([...(second ?? [])]).toEqual([0, 1]);
        expect(url).toBe("https://api.mistral.ai/v1/embeddings");
        expect(body).toEqual({ model: "mistral-embed", input: ["a", "b"] });
        expect(auth).toBe("Bearer k");
    });

    it("waits out a rate limit as the service asks, then gives up when the search does", async () => {
        vi.useFakeTimers();
        try {
            let calls = 0;
            const fakeFetch = (async () => {
                calls++;
                return calls === 1
                    ? new Response("slow down", { status: 429, headers: { "retry-after": "3" } })
                    : Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
            }) as unknown as typeof fetch;
            const embedder = createEmbedder({ provider: "mistral", baseUrl: "https://x", model: "m" }, fakeFetch);
            const done = embedder.embed(["a"]);
            await vi.advanceTimersByTimeAsync(2_900);
            expect(calls).toBe(1);
            await vi.advanceTimersByTimeAsync(200);
            expect(await done).toHaveLength(1);

            const busy = (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch;
            const searching = new AbortController();
            const given = createEmbedder({ provider: "mistral", baseUrl: "https://x", model: "m" }, busy).embed(
                ["a"],
                searching.signal,
            );
            const outcome = expect(given).rejects.toBeDefined();
            await vi.advanceTimersByTimeAsync(10);
            searching.abort(new Error("search took too long"));
            await outcome;
        } finally {
            vi.useRealTimers();
        }
    });

    it("fails with the service's answer on a bad request", async () => {
        const fakeFetch = (async () => new Response("unknown model", { status: 400 })) as unknown as typeof fetch;
        const embedder = createEmbedder(
            { provider: "local", baseUrl: "http://localhost:11434/v1", model: "x" },
            fakeFetch,
        );

        await expect(embedder.embed(["a"])).rejects.toThrow("HTTP 400");
    });
});
