import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_REDIRECTS = 5;

/** Addresses on this machine or its network. Page reads run on the host, so they must never reach these. */
export const isPrivateAddress = (address: string): boolean => {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    if (mapped) return isPrivateAddress(mapped);
    if (isIP(address) === 4) {
        const [a = 0, b = 0] = address.split(".").map(Number);
        return (
            a === 0 ||
            a === 10 ||
            a === 127 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 198 && (b === 18 || b === 19)) ||
            a >= 224
        );
    }
    const lower = address.toLowerCase();
    return (
        lower === "::" ||
        lower === "::1" ||
        lower.startsWith("fc") ||
        lower.startsWith("fd") ||
        lower.startsWith("fe8") ||
        lower.startsWith("fe9") ||
        lower.startsWith("fea") ||
        lower.startsWith("feb") ||
        lower.startsWith("ff")
    );
};

export type Resolve = (hostname: string) => Promise<string[]>;

const resolveAll: Resolve = async (hostname) => (await lookup(hostname, { all: true })).map((entry) => entry.address);

/** Why a URL may not be fetched from the host, or undefined when it may. */
export const urlProblem = async (url: URL, resolve: Resolve = resolveAll): Promise<string | undefined> => {
    if (url.protocol !== "https:" && url.protocol !== "http:") return "only http and https pages can be read";
    if (url.username || url.password) return "links with a user name or password are not read";
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || /\.(local|internal|localhost)$/.test(host))
        return "that address is on a private network";
    const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
    if (addresses.length === 0) return `${host} does not exist`;
    if (addresses.some(isPrivateAddress)) return "that address is on a private network";
    return undefined;
};

export interface SafeFetchOptions {
    fetch?: typeof fetch;
    resolve?: Resolve;
    timeoutMs?: number;
    headers?: Record<string, string>;
    signal?: AbortSignal;
}

/**
 * `fetch` for addresses the model chose. Every hop of a redirect is checked again, so a public
 * page cannot bounce the request to the router or a cloud metadata address.
 */
export const safeFetch = async (input: string, options: SafeFetchOptions = {}): Promise<Response> => {
    const doFetch = options.fetch ?? fetch;
    const signal = AbortSignal.any([
        AbortSignal.timeout(options.timeoutMs ?? 15_000),
        ...(options.signal ? [options.signal] : []),
    ]);
    let url = new URL(input);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const problem = await urlProblem(url, options.resolve);
        if (problem) throw new Error(problem);
        const response = await doFetch(url, { headers: options.headers, redirect: "manual", signal });
        const location = response.headers.get("location");
        if (response.status < 300 || response.status >= 400 || !location) return response;
        await response.body?.cancel();
        url = new URL(location, url);
    }
    throw new Error("too many redirects");
};

/** Reads at most `limit` bytes, so a huge download stops early instead of filling memory. */
export const readLimited = async (response: Response, limit: number): Promise<{ text: string; truncated: boolean }> => {
    const reader = response.body?.getReader();
    if (!reader) return { text: "", truncated: false };
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
        if (size >= limit) {
            truncated = true;
            await reader.cancel();
            break;
        }
    }
    return { text: new TextDecoder().decode(Buffer.concat(chunks).subarray(0, limit)), truncated };
};
