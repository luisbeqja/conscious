import type { AgentMessage } from "@earendil-works/pi-agent-core";

const PAGE_GONE = "(This was the page then. It has changed since: read it again with browser_read_page.)";
const PICTURE_GONE = "[a screenshot from earlier, no longer shown]";

type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;

const isToolResult = (message: AgentMessage): message is ToolResult =>
    (message as { role?: string }).role === "toolResult";

/** A tool result's text with the page tree in its `data` left out, or undefined when it has none. */
const withoutPage = (text: string): string | undefined => {
    if (!text.includes('"page"')) return undefined;
    try {
        const parsed = JSON.parse(text) as { data?: Record<string, unknown> };
        const data = parsed.data;
        if (!data || typeof data.page !== "string") return undefined;
        const { page: _page, more: _more, ...rest } = data;
        return JSON.stringify({ ...parsed, data: { ...rest, page: PAGE_GONE } });
    } catch {
        return undefined;
    }
};

const hasPage = (message: AgentMessage): boolean =>
    isToolResult(message) &&
    message.content.some((part) => part.type === "text" && withoutPage(part.text) !== undefined);

const hasPicture = (message: AgentMessage): boolean =>
    isToolResult(message) && message.content.some((part) => part.type === "image");

/**
 * The conversation with the browser's old pages and screenshots left out. Every click returns the
 * whole page, thousands of tokens each, and every turn reads them all again: a job of thirty clicks
 * read over a hundred thousand tokens a turn, and kept them for the next message too. Only the
 * latest page and screenshot stay, or none with `keepLatest` false, as when the conversation is
 * saved: by the next message the page has moved on anyway.
 */
export const withoutOldPages = (messages: AgentMessage[], keepLatest = true): AgentMessage[] => {
    const lastPage = keepLatest ? messages.findLastIndex(hasPage) : -1;
    const lastPicture = keepLatest ? messages.findLastIndex(hasPicture) : -1;
    return messages.map((message, index) => {
        if (!isToolResult(message)) return message;
        const trimPage = index !== lastPage;
        const trimPicture = index !== lastPicture;
        let changed = false;
        const content = message.content.map((part) => {
            if (part.type === "text" && trimPage) {
                const text = withoutPage(part.text);
                if (text !== undefined) {
                    changed = true;
                    return { ...part, text };
                }
            }
            if (part.type === "image" && trimPicture) {
                changed = true;
                return { type: "text" as const, text: PICTURE_GONE };
            }
            return part;
        });
        return changed ? { ...message, content } : message;
    });
};
