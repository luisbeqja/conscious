/** A passage of a document: what a search finds, and where to start reading. */
export interface Chunk {
    /** The headings above the passage, outermost first. */
    heading: string;
    /** Where the passage starts in the document's text. */
    offset: number;
    text: string;
}

interface Piece {
    offset: number;
    text: string;
    heading: string;
    /** A heading line: a passage may start here even when it is not full. */
    section: boolean;
}

const HEADING = /^(#{1,6})\s+(.*?)[\s#]*$/;
/** A passage this short is not closed at a heading: tiny sections join the next one. */
const MIN_CHARS = 300;

/**
 * Splits a Markdown document into passages of up to `size` characters, at paragraph breaks,
 * and starts a new passage at a heading. Each passage keeps the headings above it.
 */
export const chunkMarkdown = (text: string, size = 1200): Chunk[] => {
    const chunks: Chunk[] = [];
    let open: { offset: number; heading: string; parts: string[]; length: number } | undefined;
    const close = () => {
        if (open) chunks.push({ heading: open.heading, offset: open.offset, text: open.parts.join("\n\n") });
        open = undefined;
    };
    for (const piece of pieces(text, size)) {
        if (open && (open.length + piece.text.length > size || (piece.section && open.length >= MIN_CHARS))) close();
        open ??= { offset: piece.offset, heading: piece.heading, parts: [], length: 0 };
        open.parts.push(piece.text);
        open.length += piece.text.length + 2;
    }
    close();
    return chunks;
};

/** Paragraphs and heading lines with their offsets; a paragraph longer than `size` is cut at sentences. */
const pieces = (text: string, size: number): Piece[] => {
    const out: Piece[] = [];
    const path: string[] = [];
    let start = 0;
    let lines: string[] = [];
    const flush = () => {
        const body = lines.join("\n");
        for (const part of cut(body, size)) {
            out.push({ offset: start + part.at, text: part.text, heading: trail(path), section: false });
        }
        lines = [];
    };
    let position = 0;
    for (const line of text.split("\n")) {
        const heading = HEADING.exec(line);
        if (heading?.[1] && heading[2]) {
            flush();
            path.length = Math.min(path.length, heading[1].length - 1);
            path.push(plain(heading[2]));
            out.push({ offset: position, text: line, heading: trail(path), section: true });
        } else if (!line.trim()) {
            flush();
        } else {
            if (!lines.length) start = position;
            lines.push(line);
        }
        position += line.length + 1;
    }
    flush();
    return out;
};

/** The headings above a passage: the outermost and the two nearest, as deep pages nest many. */
const trail = (path: readonly string[]): string =>
    (path.length > 3 ? [path[0], "…", ...path.slice(-2)] : path).join(" › ");

/** Cuts text into parts of at most `size` characters, after a sentence or a space when it can. */
const cut = (text: string, size: number): { at: number; text: string }[] => {
    const parts: { at: number; text: string }[] = [];
    let at = 0;
    while (at < text.length) {
        let end = Math.min(at + size, text.length);
        if (end < text.length) {
            const window = text.slice(at, end);
            const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
            const space = window.lastIndexOf(" ");
            const best = sentence > size / 2 ? sentence + 1 : space > size / 2 ? space : -1;
            if (best > 0) end = at + best;
        }
        const part = text.slice(at, end);
        if (part.trim()) parts.push({ at, text: part });
        at = end;
    }
    return parts;
};

/** Markdown as plain words: link text without its address, no tags, escapes, emphasis, headings or table pipes. */
export const plain = (markdown: string): string =>
    markdown
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/<\/?[a-z][^>]*>/gi, " ")
        .replace(/\\(\S)?/g, "$1")
        .replace(/[*_`#>|]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

const STOPWORDS = new Set(
    (
        "il lo la i gli le un uno una di del dello della dei degli delle a al allo alla ai agli alle da dal dallo " +
        "dalla dai dagli dalle in nel nello nella nei negli nelle con su sul sulla sui per tra fra e ed o od che chi " +
        "cui cosa come dove quando quale quali quanto quanti non si mi ti ci vi ne se ma anche piu sono e ho hai ha " +
        "abbiamo hanno essere avere devo deve posso puo mio mia miei mie suo sua the an of to for and or how what " +
        "is are do does can my me on with from at by it this that which who when where"
    ).split(" "),
);

/**
 * Words for the keyword index: lowercase, no accents, and a light Italian stemmer, so that
 * "rinnovo", "rinnovare" and "rinnovata" are one word, as are "carta" and "carte".
 */
export const terms = (text: string, dropStopwords = false): string[] =>
    text
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word && !(dropStopwords && STOPWORDS.has(word)))
        .map(stem);

const SUFFIXES = [
    "azioni",
    "azione",
    "amenti",
    "amento",
    "imenti",
    "imento",
    "mente",
    "zioni",
    "zione",
    "abili",
    "abile",
    "ibili",
    "ibile",
    "ando",
    "endo",
    "are",
    "ere",
    "ire",
    "ato",
    "ata",
    "ati",
    "ate",
    "uto",
    "uta",
    "uti",
    "ute",
    "ito",
    "iti",
    "ite",
];

export const stem = (word: string): string => {
    if (word.length < 5 || /\d/.test(word)) return word;
    for (const suffix of SUFFIXES) {
        if (word.endsWith(suffix) && word.length - suffix.length >= 4) return word.slice(0, -suffix.length);
    }
    return /[aeiou]$/.test(word) ? word.slice(0, -1) : word;
};
