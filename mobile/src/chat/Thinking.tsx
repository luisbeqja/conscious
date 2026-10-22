import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, {
    cancelAnimation,
    Easing,
    FadeIn,
    FadeOut,
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withRepeat,
    withSequence,
    withTiming,
} from "react-native-reanimated";
import { type Palette, type } from "../theme";

const Dot = ({ delay, color }: { delay: number; color: string }) => {
    const progress = useSharedValue(0);
    useEffect(() => {
        progress.value = withDelay(
            delay,
            withRepeat(
                withSequence(
                    withTiming(1, { duration: 380, easing: Easing.out(Easing.quad) }),
                    withTiming(0, { duration: 380, easing: Easing.in(Easing.quad) }),
                    withTiming(0, { duration: 260 }),
                ),
                -1,
            ),
        );
        return () => cancelAnimation(progress);
    }, [delay, progress]);
    const style = useAnimatedStyle(() => ({
        opacity: 0.35 + progress.value * 0.65,
        transform: [{ translateY: -3 * progress.value }],
    }));
    return <Animated.View style={[styles.dot, { backgroundColor: color }, style]} />;
};

/** Shown while Conscious works and has not started writing: three dots, and what it is doing. */
export const Thinking = ({ palette, label }: { palette: Palette; label?: string }) => (
    <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(120)} style={styles.row}>
        <View style={styles.dots} accessibilityLabel={label ?? "Conscious is thinking"}>
            <Dot delay={0} color={palette.muted} />
            <Dot delay={140} color={palette.muted} />
            <Dot delay={280} color={palette.muted} />
        </View>
        {label ? (
            <Animated.View key={label} entering={FadeIn.duration(250)}>
                <Text style={[type.small, { color: palette.muted }]}>{label}…</Text>
            </Animated.View>
        ) : null}
    </Animated.View>
);

const styles = StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: 10, height: 28 },
    dots: { flexDirection: "row", alignItems: "center", gap: 5 },
    dot: { width: 7, height: 7, borderRadius: 3.5 },
});
