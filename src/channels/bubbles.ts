const MAX_BUBBLES = 4;
const MAX_BUBBLE_CHARS = 320;
const LIST_ITEM = /^\s*([-•*]|\d+[.)])\s/m;

/**
 * A reply as the separate messages a person would send: short paragraphs become bubbles of their
 * own. Anything that reads as one piece (a long paragraph, a list, many parts) stays whole.
 */
export const bubbles = (text: string): string[] => {
    const parts = text
        .split(/\n\s*\n/)
        .map((part) => part.trim())
        .filter(Boolean);
    const chatty =
        parts.length >= 2 &&
        parts.length <= MAX_BUBBLES &&
        parts.every((part) => part.length <= MAX_BUBBLE_CHARS && !LIST_ITEM.test(part));
    return chatty ? parts : [text];
};

/** The pause before the next bubble: long enough to read as typing, short enough not to drag. */
export const bubblePauseMs = (next: string): number => Math.min(600 + next.length * 15, 2_000);
