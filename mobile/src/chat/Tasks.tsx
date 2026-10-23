import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { Dot } from "../dot/Dot";
import type { AppTask } from "../protocol";
import { type Palette, type } from "../theme";
import { toolLabel } from "../tools";

const minutesSince = (startedAt: string, now: number): string => {
    const minutes = Math.floor((now - new Date(startedAt).getTime()) / 60_000);
    return minutes < 1 ? "just started" : `${minutes} min`;
};

const detail = (task: AppTask, now: number): string =>
    [
        task.parts ? `${task.parts.done} of ${task.parts.total} parts done` : toolLabel(task.lastStep ?? ""),
        minutesSince(task.startedAt, now),
    ]
        .filter(Boolean)
        .join(" · ");

/** The jobs Conscious is doing in the background, under the header while they run. The chat stays free. */
export const Tasks = ({ tasks, palette }: { tasks: AppTask[]; palette: Palette }) => {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!tasks.length) return;
        const timer = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(timer);
    }, [tasks.length]);
    if (!tasks.length) return null;
    return (
        <Animated.View layout={LinearTransition.duration(200)} style={styles.list}>
            {tasks.map((task) => (
                <Animated.View
                    key={task.id}
                    entering={FadeIn.duration(250)}
                    exiting={FadeOut.duration(200)}
                    style={[styles.task, { backgroundColor: palette.surface, borderColor: palette.hairline }]}
                    accessibilityLabel={`Working in the background: ${task.title}`}
                >
                    <Dot size={18} mood="thinking" />
                    <View style={styles.text}>
                        <Text style={[type.small, styles.title, { color: palette.text }]} numberOfLines={1}>
                            {task.title}
                        </Text>
                        <Text style={[type.caption, { color: palette.muted }]} numberOfLines={1}>
                            {detail(task, now)}
                        </Text>
                    </View>
                </Animated.View>
            ))}
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    list: { paddingHorizontal: 12, paddingTop: 8, gap: 6 },
    task: {
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    text: { flex: 1 },
    title: { fontWeight: "600" },
});
