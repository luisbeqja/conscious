import { router } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Dot } from "../dot/Dot";
import { type DotMood, MOODS } from "../dot/motion";
import { type, usePalette } from "../theme";

const MEANING: Record<DotMood, string> = {
    idle: "Available. A gentle drift, with moments of stillness.",
    thinking: "Working on something. A calm, compact orbit.",
    confirmed: "Done. One decisive stroke, then rest.",
    error: "Something failed. It stops short and steps back.",
    awaiting: "Waiting for your answer. A small questioning loop now and then.",
};

// Confirmed and error play once; after them the dot rests, as it does in the chat.
const ONE_SHOT: DotMood[] = ["confirmed", "error"];

/** A playground for the mascot: every expression, at every size. */
export default function DotPreview() {
    const palette = usePalette();
    const insets = useSafeAreaInsets();
    const systemReduced = useReducedMotion();
    const [mood, setMood] = useState<DotMood>("idle");
    const [reduced, setReduced] = useState(systemReduced);

    const play = (next: DotMood) => {
        if (ONE_SHOT.includes(next) && mood === next) {
            // Replaying the same gesture needs a beat of idle in between.
            setMood("idle");
            setTimeout(() => setMood(next), 60);
            return;
        }
        setMood(next);
    };

    return (
        <ScrollView
            style={{ backgroundColor: palette.background }}
            contentContainerStyle={[styles.content, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24 }]}
        >
            <View style={styles.top}>
                <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} hitSlop={12}>
                    <Text style={[type.body, { color: palette.accent }]}>Back</Text>
                </Pressable>
                <Text style={[type.title, { color: palette.text }]}>The Dot</Text>
                <View style={styles.topSide} />
            </View>

            <View style={styles.stage}>
                <Dot size={200} mood={mood} reduceMotion={reduced} />
            </View>
            <Text style={[type.small, styles.meaning, { color: palette.muted }]}>{MEANING[mood]}</Text>

            <View style={styles.moods}>
                {MOODS.map((name) => (
                    <Pressable
                        key={name}
                        onPress={() => play(name)}
                        style={[
                            styles.mood,
                            {
                                backgroundColor: name === mood ? palette.text : palette.surface,
                                borderColor: palette.hairline,
                            },
                        ]}
                    >
                        <Text style={[type.small, { color: name === mood ? palette.background : palette.text }]}>
                            {name}
                        </Text>
                    </Pressable>
                ))}
            </View>

            <View style={styles.sizes}>
                {[24, 36, 64, 120].map((size) => (
                    <View key={size} style={styles.size}>
                        <Dot size={size} mood={mood} reduceMotion={reduced} />
                        <Text style={[type.caption, { color: palette.faint }]}>{size}px</Text>
                    </View>
                ))}
            </View>

            <View style={[styles.row, { borderColor: palette.hairline }]}>
                <Text style={[type.body, { color: palette.text }]}>Reduce motion</Text>
                <Switch value={reduced} onValueChange={setReduced} />
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    content: { paddingHorizontal: 20, gap: 18 },
    top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    topSide: { width: 40 },
    stage: { alignItems: "center", marginTop: 12 },
    meaning: { textAlign: "center", minHeight: 36 },
    moods: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8 },
    mood: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 8 },
    sizes: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-around", marginTop: 8 },
    size: { alignItems: "center", gap: 6 },
    row: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        borderTopWidth: StyleSheet.hairlineWidth,
        paddingTop: 16,
    },
});
