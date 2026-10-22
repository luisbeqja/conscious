const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export const decodeEntities = (text: string): string =>
    text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
        if (name.startsWith("#x") || name.startsWith("#X"))
            return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
        if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
        return ENTITIES[name.toLowerCase()] ?? whole;
    });

export const stripTags = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, "")).trim();

const BLOCK = /<\/?(p|div|br|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|blockquote|pre)\b[^>]*>/gi;

/**
 * The readable text of a page, without a DOM. Navigation, scripts and forms go first; what is
 * left keeps its paragraph breaks so the model can tell a heading from a price.
 */
export const htmlToText = (html: string): { title?: string; text: string } => {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
    const main = /<(main|article)\b[^>]*>([\s\S]*)<\/\1>/i.exec(html)?.[2] ?? html;
    const text = main
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<(script|style|noscript|svg|nav|form|iframe|template|head)\b[\s\S]*?<\/\1>/gi, "")
        .replace(/<h([1-6])\b[^>]*>/gi, (_match, level: string) => `\n${"#".repeat(Number(level))} `)
        .replace(/<li\b[^>]*>/gi, "\n- ")
        .replace(BLOCK, "\n")
        .replace(/<[^>]*>/g, " ");
    return {
        title: title ? stripTags(title) : undefined,
        text: decodeEntities(text)
            .replace(/[ \t\f\v ]+/g, " ")
            .replace(/ *\n */g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim(),
    };
};
