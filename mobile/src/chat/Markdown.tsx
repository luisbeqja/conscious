import { Fragment, type ReactNode } from "react";
import { Linking, StyleSheet, Text, type TextStyle, View } from "react-native";
import { fonts, type Palette, type } from "../theme";

/**
 * The small part of Markdown the agent writes, read the way chat apps read it: *bold* is
 * bold (as on WhatsApp) as well as **bold**, _italic_, ~strike~, `code`, links, lists,
 * headings and code blocks. Half-written syntax while streaming just shows as text.
 */
type Block =
    | { kind: "paragraph"; text: string }
    | { kind: "heading"; text: string }
    | { kind: "bullet"; text: string; marker: string }
    | { kind: "quote"; text: string }
    | { kind: "code"; text: string };

const parseBlocks = (source: string): Block[] => {
    const blocks: Block[] = [];
    const lines = source.replace(/\r\n/g, "\n").split("\n");
    let paragraph: string[] = [];
    const endParagraph = () => {
        if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
        paragraph = [];
    };
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (line.trimStart().startsWith("```")) {
            endParagraph();
            const code: string[] = [];
            index += 1;
            while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith("```")) {
                code.push(lines[index] ?? "");
                index += 1;
            }
            blocks.push({ kind: "code", text: code.join("\n") });
            continue;
        }
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        const bullet = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(line);
        const quote = /^>\s?(.*)$/.exec(line);
        if (heading) {
            endParagraph();
            blocks.push({ kind: "heading", text: heading[1] ?? "" });
        } else if (bullet) {
            endParagraph();
            const marker = bullet[1] ?? "-";
            blocks.push({ kind: "bullet", text: bullet[2] ?? "", marker: /\d/.test(marker) ? marker : "•" });
        } else if (quote) {
            endParagraph();
            blocks.push({ kind: "quote", text: quote[1] ?? "" });
        } else if (!line.trim()) {
            endParagraph();
        } else {
            paragraph.push(line);
        }
    }
    endParagraph();
    return blocks;
};

const INLINE =
    /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_|~[^~\s][^~\n]*~|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

const renderInline = (text: string, palette: Palette, key = ""): ReactNode[] => {
    const parts: ReactNode[] = [];
    let last = 0;
    for (const match of text.matchAll(INLINE)) {
        const token = match[0];
        const start = match.index ?? 0;
        if (start > last) parts.push(text.slice(last, start));
        const id = `${key}${start}`;
        if (token.startsWith("**") || token.startsWith("__")) {
            parts.push(
                <Text key={id} style={styles.bold}>
                    {renderInline(token.slice(2, -2), palette, `${id}-`)}
                </Text>,
            );
        } else if (token.startsWith("*")) {
            parts.push(
                <Text key={id} style={styles.bold}>
                    {renderInline(token.slice(1, -1), palette, `${id}-`)}
                </Text>,
            );
        } else if (token.startsWith("_")) {
            parts.push(
                <Text key={id} style={styles.italic}>
                    {renderInline(token.slice(1, -1), palette, `${id}-`)}
                </Text>,
            );
        } else if (token.startsWith("~")) {
            parts.push(
                <Text key={id} style={styles.strike}>
                    {token.slice(1, -1)}
                </Text>,
            );
        } else if (token.startsWith("`")) {
            parts.push(
                <Text key={id} style={[styles.inlineCode, { backgroundColor: palette.code }]}>
                    {token.slice(1, -1)}
                </Text>,
            );
        } else {
            const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
            const label = link ? link[1] : token.replace(/^https?:\/\/(www\.)?/, "");
            const url = link ? link[2] : token;
            parts.push(
                <Text
                    key={id}
                    style={[styles.link, { color: palette.accent }]}
                    onPress={() => url && Linking.openURL(url)}
                    accessibilityRole="link"
                >
                    {label}
                </Text>,
            );
        }
        last = start + token.length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
};

export const Markdown = ({ text, palette, style }: { text: string; palette: Palette; style?: TextStyle }) => {
    const blocks = parseBlocks(text);
    const base = [type.body, { color: palette.text }, style];
    return (
        <View style={styles.column}>
            {blocks.map((block, index) => {
                const key = `${index}-${block.kind}`;
                switch (block.kind) {
                    case "code":
                        return (
                            <View key={key} style={[styles.codeBlock, { backgroundColor: palette.code }]}>
                                <Text style={[styles.codeText, { color: palette.text }]}>{block.text}</Text>
                            </View>
                        );
                    case "heading":
                        return (
                            <Text key={key} style={[base, styles.heading]}>
                                {renderInline(block.text, palette)}
                            </Text>
                        );
                    case "bullet":
                        return (
                            <View key={key} style={styles.bulletRow}>
                                <Text style={[base, styles.marker, { color: palette.muted }]}>{block.marker}</Text>
                                <Text style={[base, styles.flex]}>{renderInline(block.text, palette)}</Text>
                            </View>
                        );
                    case "quote":
                        return (
                            <View key={key} style={[styles.quote, { borderColor: palette.faint }]}>
                                <Text style={[base, { color: palette.muted }]}>{renderInline(block.text, palette)}</Text>
                            </View>
                        );
                    default:
                        return (
                            <Text key={key} style={base}>
                                {block.text.split("\n").map((line, lineIndex) => (
                                    <Fragment key={`${key}-${lineIndex.toString()}`}>
                                        {lineIndex > 0 ? "\n" : null}
                                        {renderInline(line, palette, `${lineIndex}-`)}
                                    </Fragment>
                                ))}
                            </Text>
                        );
                }
            })}
        </View>
    );
};

const styles = StyleSheet.create({
    column: { gap: 10 },
    bold: { fontWeight: "600" },
    italic: { fontStyle: "italic" },
    strike: { textDecorationLine: "line-through" },
    link: { textDecorationLine: "underline" },
    inlineCode: { fontFamily: fonts.mono, fontSize: 15 },
    heading: { fontWeight: "700", marginTop: 4 },
    bulletRow: { flexDirection: "row", gap: 8, marginTop: -4, paddingRight: 8 },
    marker: { minWidth: 14, fontVariant: ["tabular-nums"] },
    flex: { flex: 1 },
    quote: { borderLeftWidth: 3, paddingLeft: 12 },
    codeBlock: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
    codeText: { fontFamily: fonts.mono, fontSize: 14, lineHeight: 20 },
});
