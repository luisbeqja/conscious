import { StyleSheet, Text } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { Dot } from "../dot/Dot";
import { type Palette, type } from "../theme";

/** Shown while Conscious works and has not started writing: the dot at work, and what it is doing. */
export const Thinking = ({ palette, label }: { palette: Palette; label?: string }) => (
    <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(120)} style={styles.row}>
        <Dot size={30} mood="thinking" />
        {label ? (
            <Animated.View key={label} entering={FadeIn.duration(250)}>
                <Text style={[type.small, { color: palette.muted }]}>{label}…</Text>
            </Animated.View>
        ) : null}
    </Animated.View>
);

const styles = StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: 8, height: 30, marginLeft: -6 },
});
