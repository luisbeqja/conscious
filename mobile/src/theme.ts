import { Platform, useColorScheme } from "react-native";

const light = {
    background: "#F7F6F2",
    surface: "#FFFFFF",
    surfacePressed: "#EFEEE9",
    text: "#1B1B19",
    muted: "#7A7A73",
    faint: "#B5B4AC",
    hairline: "rgba(27, 27, 25, 0.09)",
    accent: "#2F6F4F",
    accentPressed: "#285E43",
    onAccent: "#FFFFFF",
    accentSoft: "#E3EDE6",
    bubble: "#2F6F4F",
    bubblePressed: "#285E43",
    danger: "#B3261E",
    code: "#EEEDE7",
    shadow: "rgba(27, 27, 25, 0.10)",
};

export type Palette = typeof light;

const dark: Palette = {
    background: "#0F0F0E",
    surface: "#1B1B19",
    surfacePressed: "#252522",
    text: "#EDEDE8",
    muted: "#9A9A92",
    faint: "#5C5C56",
    hairline: "rgba(237, 237, 232, 0.10)",
    accent: "#4E9A72",
    accentPressed: "#438764",
    onAccent: "#FFFFFF",
    accentSoft: "#1E2B24",
    bubble: "#2E6A4A",
    bubblePressed: "#285D41",
    danger: "#F2B8B5",
    code: "#22221F",
    shadow: "rgba(0, 0, 0, 0.5)",
};

export const usePalette = (): Palette => (useColorScheme() === "dark" ? dark : light);

export const fonts = {
    body: Platform.select({ ios: "System", default: undefined }),
    mono: Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" }),
};

export const type = {
    body: { fontSize: 17, lineHeight: 25, letterSpacing: -0.2 },
    small: { fontSize: 13, lineHeight: 18, letterSpacing: -0.05 },
    caption: { fontSize: 12, lineHeight: 16, letterSpacing: 0.1 },
    title: { fontSize: 17, lineHeight: 22, fontWeight: "600" as const, letterSpacing: -0.3 },
    display: { fontSize: 34, lineHeight: 40, fontWeight: "700" as const, letterSpacing: -0.8 },
};
