import { describe, expect, it } from "vitest";
import type { ToolContext } from "../src/capabilities/types.js";
import { createWebCapability } from "../src/capabilities/web/capability.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { htmlToText } from "../src/web/html-text.js";
import { isPrivateAddress, urlProblem } from "../src/web/safe-fetch.js";
import {
    braveSearch,
    duckDuckGoSearch,
    parseDuckDuckGo,
    parseDuckDuckGoLite,
    type SearchProvider,
} from "../src/web/search.js";

const context: ToolContext = { userId: "u1", timezone: "Europe/Rome", scheduler: new Scheduler(async () => {}) };
const publicDns = async () => ["93.184.216.34"];
const tool = (capability: ReturnType<typeof createWebCapability>, name: string) => {
    const found = capability.tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(name);
    return found;
};

describe("web search", () => {
    it("parses DuckDuckGo's results page and skips ads", () => {
        const html = `
<div class="result results_links result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad">Ad</a></div>
<div class="result results_links results_links_deep web-result ">
  <h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.comune.milano.it%2Fmusei&amp;rut=x">Musei <b>Milano</b></a></h2>
  <a class="result__snippet" href="x">Orari &amp; biglietti dei musei civici.</a>
</div>
<div class="result results_links web-result"><a class="result__a" href="https://example.org/two">Two</a></div>`;
        expect(parseDuckDuckGo(html, 5)).toEqual([
            {
                title: "Musei Milano",
                url: "https://www.comune.milano.it/musei",
                snippet: "Orari & biglietti dei musei civici.",
            },
            { title: "Two", url: "https://example.org/two", snippet: "" },
        ]);
    });

    it("parses DuckDuckGo Lite's results table and skips ads", () => {
        const html = `
<tr><td><a rel="nofollow" href="https://duckduckgo.com/y.js?ad_domain=x" class='result-link'>Ad</a></td></tr>
<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.comune.milano.it%2Fservizi%2Ftributi%2Ftari%2Dpagamento&amp;rut=1" class='result-link'>Tari: pagamento</a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>Come pagare la <b>Tari</b> a Milano.</td></tr>
<tr><td><span class='link-text'>www.comune.milano.it/servizi/tributi/tari-pag</span></td></tr>`;
        expect(parseDuckDuckGoLite(html, 5)).toEqual([
            {
                title: "Tari: pagamento",
                url: "https://www.comune.milano.it/servizi/tributi/tari-pagamento",
                snippet: "Come pagare la Tari a Milano.",
            },
        ]);
    });

    it("searches DuckDuckGo with a GET, which it answers from cloud servers, and falls back to Lite", async () => {
        const asked: { url: string; method?: string }[] = [];
        const lite = `<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.it" class='result-link'>A</a><td class='result-snippet'>a</td>`;
        const fakeFetch = (async (input: string, init?: RequestInit) => {
            asked.push({ url: input, method: init?.method });
            return input.startsWith("https://html.")
                ? new Response('<div class="anomaly-modal"></div>', { status: 202 })
                : new Response(lite);
        }) as unknown as typeof fetch;
        const results = await duckDuckGoSearch(fakeFetch).search("tari milano", {
            count: 3,
            country: "it",
            language: "it",
        });

        expect(results).toEqual([{ title: "A", url: "https://a.it", snippet: "a" }]);
        expect(asked.map((request) => request.method ?? "GET")).toEqual(["GET", "GET"]);
        expect(asked[0]?.url).toBe("https://html.duckduckgo.com/html/?q=tari+milano&kl=it-it");
        expect(asked[1]?.url).toBe("https://lite.duckduckgo.com/lite/?q=tari+milano&kl=it-it");
    });

    it("asks Brave with the key and maps its results", async () => {
        let seen: URL | undefined;
        let key: string | undefined;
        const fakeFetch = (async (input: URL, init?: RequestInit) => {
            seen = input;
            key = (init?.headers as Record<string, string>)["x-subscription-token"];
            return Response.json({
                web: { results: [{ title: "A <strong>b</strong>", url: "https://a.b", description: "c" }] },
            });
        }) as typeof fetch;
        const results = await braveSearch("k1", fakeFetch).search("pizza", {
            count: 3,
            country: "it",
            freshness: "week",
        });
        expect(results).toEqual([{ title: "A b", url: "https://a.b", snippet: "c" }]);
        expect(key).toBe("k1");
        expect(seen?.searchParams.get("freshness")).toBe("pw");
        expect(seen?.searchParams.get("country")).toBe("it");
    });

    it("hands the model results with a reminder to check the page", async () => {
        const search: SearchProvider = {
            name: "fake",
            search: async (query) => [{ title: query, url: "https://x.y", snippet: "s" }],
        };
        const output = await tool(createWebCapability({ search }), "web_search_pages").execute({ query: "q" }, context);
        expect(output.data).toEqual({ results: [{ title: "q", url: "https://x.y", snippet: "s" }] });
        expect(output.guidance).toMatch(/Read the page/);
    });
});

describe("reading pages", () => {
    it("keeps the readable text of a page and drops scripts and navigation", () => {
        const page = htmlToText(`<html><head><title>Bar &amp; Co</title><style>x{}</style></head><body>
<nav>Home | About</nav><main><h1>Opening hours</h1><p>Mon&ndash;Fri 9&#8211;18</p><script>evil()</script>
<ul><li>Sat 10-14</li></ul></main></body></html>`);
        expect(page.title).toBe("Bar & Co");
        expect(page.text).toContain("# Opening hours");
        expect(page.text).toContain("- Sat 10-14");
        expect(page.text).not.toMatch(/evil|Home \| About/);
    });

    it("never reaches this machine or its network", async () => {
        for (const address of [
            "127.0.0.1",
            "10.1.2.3",
            "192.168.1.1",
            "169.254.169.254",
            "::1",
            "fd00::1",
            "::ffff:10.0.0.1",
        ]) {
            expect(isPrivateAddress(address), address).toBe(true);
        }
        expect(isPrivateAddress("93.184.216.34")).toBe(false);
        expect(await urlProblem(new URL("http://localhost:8787/vault"))).toMatch(/private/);
        expect(await urlProblem(new URL("http://router.example"), async () => ["192.168.1.1"])).toMatch(/private/);
        expect(await urlProblem(new URL("file:///etc/passwd"))).toMatch(/http/);
        expect(await urlProblem(new URL("https://example.com"), publicDns)).toBeUndefined();
    });

    it("checks every redirect, so a public page cannot bounce to a private one", async () => {
        const fakeFetch = (async () =>
            new Response(null, {
                status: 302,
                headers: { location: "http://169.254.169.254/latest/meta-data" },
            })) as unknown as typeof fetch;
        const capability = createWebCapability({
            search: { name: "x", search: async () => [] },
            fetch: fakeFetch,
            resolve: publicDns,
        });
        const output = await tool(capability, "web_read_page").execute({ url: "https://short.link/a" }, context);
        expect(output.data).toEqual({ error: "Could not open the page: that address is on a private network" });
    });

    it("reads long pages in parts", async () => {
        const body = `<p>${"word ".repeat(2000)}</p>`;
        const fakeFetch = (async () =>
            new Response(body, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
        const capability = createWebCapability({
            search: { name: "x", search: async () => [] },
            fetch: fakeFetch,
            resolve: publicDns,
        });
        const read = tool(capability, "web_read_page");
        const first = (await read.execute({ url: "https://a.example/", maxChars: 1000 }, context)).data as Record<
            string,
            unknown
        >;
        expect((first.text as string).length).toBe(1000);
        expect(first.nextOffset).toBe(1000);
        const next = (await read.execute({ url: "https://a.example/", offset: 9500 }, context)).data as Record<
            string,
            unknown
        >;
        expect(next.nextOffset).toBeUndefined();
    });

    it("refuses files it cannot read as text", async () => {
        const fakeFetch = (async () =>
            new Response("x", { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
        const capability = createWebCapability({
            search: { name: "x", search: async () => [] },
            fetch: fakeFetch,
            resolve: publicDns,
        });
        const output = await tool(capability, "web_read_page").execute({ url: "https://a.example/i.png" }, context);
        expect(output.data).toEqual({ error: "This file is image/png, not a page I can read as text." });
    });
});
