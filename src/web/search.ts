import { stripTags } from "./html-text.js";

export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
}

export interface SearchOptions {
    count: number;
    /** Two-letter country and language codes, e.g. "it" and "it", when the user is somewhere specific. */
    country?: string;
    language?: string;
    /** Only results from roughly the last day, week, month or year. */
    freshness?: "day" | "week" | "month" | "year";
    signal?: AbortSignal;
}

export interface SearchProvider {
    name: string;
    search(query: string, options: SearchOptions): Promise<SearchResult[]>;
}

export type SearchConfig =
    | { provider: "duckduckgo" }
    | { provider: "brave"; apiKey: string }
    | { provider: "searxng"; url: string };

const USER_AGENT = "Mozilla/5.0 (compatible; Conscious/0.1; +https://github.com/luisbeqja/conscious)";

const failed = async (name: string, response: Response): Promise<never> => {
    await response.body?.cancel();
    throw new Error(`${name} search failed (HTTP ${response.status})`);
};

const timeout = (signal?: AbortSignal) => AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);

/** Brave's own index. Needs a key from api-dashboard.search.brave.com. */
export const braveSearch = (apiKey: string, doFetch: typeof fetch = fetch): SearchProvider => ({
    name: "brave",
    search: async (query, options) => {
        const url = new URL("https://api.search.brave.com/res/v1/web/search");
        url.searchParams.set("q", query);
        url.searchParams.set("count", String(options.count));
        if (options.country) url.searchParams.set("country", options.country);
        if (options.language) url.searchParams.set("search_lang", options.language);
        if (options.freshness) url.searchParams.set("freshness", `p${options.freshness[0]}`);
        const response = await doFetch(url, {
            headers: { accept: "application/json", "x-subscription-token": apiKey },
            signal: timeout(options.signal),
        });
        if (!response.ok) return failed("Brave", response);
        const body = (await response.json()) as {
            web?: { results?: { title: string; url: string; description?: string }[] };
        };
        return (body.web?.results ?? []).map((result) => ({
            title: stripTags(result.title),
            url: result.url,
            snippet: stripTags(result.description ?? ""),
        }));
    },
});

/** A SearXNG instance, usually the user's own. Its JSON output has to be enabled in settings.yml. */
export const searxngSearch = (base: string, doFetch: typeof fetch = fetch): SearchProvider => ({
    name: "searxng",
    search: async (query, options) => {
        const url = new URL("search", base.endsWith("/") ? base : `${base}/`);
        url.searchParams.set("q", query);
        url.searchParams.set("format", "json");
        if (options.language) url.searchParams.set("language", options.language);
        if (options.freshness) url.searchParams.set("time_range", options.freshness);
        const response = await doFetch(url, {
            headers: { accept: "application/json" },
            signal: timeout(options.signal),
        });
        if (!response.ok) return failed("SearXNG", response);
        const body = (await response.json()) as { results?: { title: string; url: string; content?: string }[] };
        return (body.results ?? []).slice(0, options.count).map((result) => ({
            title: result.title,
            url: result.url,
            snippet: result.content ?? "",
        }));
    },
});

const DDG_FRESHNESS = { day: "d", week: "w", month: "m", year: "y" } as const;

/** The real address behind DuckDuckGo's click-through link. */
const ddgTarget = (href: string): string => {
    const url = new URL(href, "https://duckduckgo.com");
    return url.searchParams.get("uddg") ?? url.toString();
};

/** Parses DuckDuckGo's no-JavaScript results page. */
export const parseDuckDuckGo = (html: string, count: number): SearchResult[] => {
    const results: SearchResult[] = [];
    const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1);
    for (const block of blocks) {
        if (/result--ad\b/.test(block.slice(0, 200))) continue;
        const link = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
        if (!link?.[1] || !link[2]) continue;
        const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/(a|td|div)>/.exec(block)?.[1] ?? "";
        const url = ddgTarget(link[1].replace(/&amp;/g, "&"));
        if (url.includes("duckduckgo.com/y.js")) continue;
        results.push({ title: stripTags(link[2]), url, snippet: stripTags(snippet) });
        if (results.length >= count) break;
    }
    return results;
};

/** Parses DuckDuckGo Lite's results page: a table, one link and one snippet per result. */
export const parseDuckDuckGoLite = (html: string, count: number): SearchResult[] => {
    const results: SearchResult[] = [];
    const links =
        /<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class=['"]result-link['"]|$)/g;
    for (const [, href, title, rest] of html.matchAll(links)) {
        if (!href || !title) continue;
        const url = ddgTarget(href.replace(/&amp;/g, "&"));
        if (url.includes("duckduckgo.com/y.js")) continue;
        const snippet = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/.exec(rest ?? "")?.[1] ?? "";
        results.push({ title: stripTags(title), url, snippet: stripTags(snippet) });
        if (results.length >= count) break;
    }
    return results;
};

/** DuckDuckGo's answer to a search it will not serve: HTTP 202 with a challenge instead of results. */
const limited = (response: Response, html: string): boolean =>
    response.status === 202 || (/anomaly-modal|captcha/i.test(html) && !/result__a|result-link/.test(html));

/**
 * DuckDuckGo needs no key, so it is the default. It turns away POSTs from cloud servers such as
 * Railway's but answers GETs, so searches are GETs; when the HTML page is limited anyway, the
 * Lite one often is not. An install that searches a lot should still set a Brave key or its own SearXNG.
 */
export const duckDuckGoSearch = (doFetch: typeof fetch = fetch): SearchProvider => ({
    name: "duckduckgo",
    search: async (query, options) => {
        const params = new URLSearchParams({ q: query });
        if (options.country) params.set("kl", `${options.country}-${options.language ?? options.country}`);
        if (options.freshness) params.set("df", DDG_FRESHNESS[options.freshness]);
        const pages = [
            { url: "https://html.duckduckgo.com/html/", parse: parseDuckDuckGo },
            { url: "https://lite.duckduckgo.com/lite/", parse: parseDuckDuckGoLite },
        ];
        for (const page of pages) {
            const response = await doFetch(`${page.url}?${params}`, {
                headers: { "user-agent": USER_AGENT },
                signal: timeout(options.signal),
            });
            if (!response.ok) return failed("DuckDuckGo", response);
            const html = await response.text();
            if (!limited(response, html)) return page.parse(html, options.count);
        }
        throw new Error(
            "DuckDuckGo is limiting searches from this address. Set BRAVE_API_KEY or CONSCIOUS_SEARXNG_URL.",
        );
    },
});

export const createSearchProvider = (config: SearchConfig, doFetch: typeof fetch = fetch): SearchProvider => {
    if (config.provider === "brave") return braveSearch(config.apiKey, doFetch);
    if (config.provider === "searxng") return searxngSearch(config.url, doFetch);
    return duckDuckGoSearch(doFetch);
};
