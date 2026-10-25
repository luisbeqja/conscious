/**
 * One id per person across platforms. WhatsApp reports a number as bare digits
 * (393331234567) while iMessage and the allow list use E.164 (+39 333 123 4567),
 * so phone numbers become "+" and digits; an Apple ID email is only lowercased.
 */
export const userIdOf = (sender: string): string => {
    const trimmed = sender.trim();
    if (/^\+?[\d\s().-]+$/.test(trimmed)) return `+${trimmed.replace(/\D/g, "")}`;
    return trimmed.toLowerCase();
};
