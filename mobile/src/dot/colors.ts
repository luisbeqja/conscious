import { useColorScheme } from "react-native";

const shared = {
    lavender: "#C8C9FF",
    periwinkle: "#AFC5FF",
    peach: "#F3D7B7",
    coral: "#F1A3AE",
};

/** The Dot's colours. The dot is the character; the pastels only ever follow it. */
export const dotColors = {
    light: { ...shared, dot: "#181B25" },
    // A charcoal dot disappears on a dark screen, so there it turns to a soft ivory instead.
    dark: { ...shared, dot: "#ECEBF5" },
};

export type DotColors = typeof dotColors.light;

export const useDotColors = (): DotColors => (useColorScheme() === "dark" ? dotColors.dark : dotColors.light);
