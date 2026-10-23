import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
    Easing,
    interpolateColor,
    ReduceMotion,
    type SharedValue,
    useAnimatedProps,
    useFrameCallback,
    useReducedMotion,
    useSharedValue,
    withRepeat,
    withSequence,
    withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { type DotColors, useDotColors } from "./colors";
import { ACCENT_CORAL, ACCENT_NONE, type DotMood, type Engine, MOODS, newEngine, setMood, step } from "./motion";

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** Oldest point the trail can ever need; the live length is shorter and changes per expression. */
const HISTORY_MS = 900;

/** Dot positions in pixels, newest last, as [x, y, time] triples. */
type History = number[];

const LABELS: Record<DotMood, string> = {
    idle: "Conscious is here",
    thinking: "Conscious is working",
    confirmed: "Done",
    error: "Something went wrong",
    awaiting: "Conscious is waiting for you",
};

interface Geometry {
    size: number;
    dot: number;
    radius: number;
    segments: number;
    layerOpacity: number;
    trailScale: number;
}

const geometry = (size: number): Geometry => {
    const dot = Math.min(16, Math.max(6, size * 0.18));
    // Small sizes keep the same character with a shorter, simpler trail.
    const micro = size < 40;
    return {
        size,
        dot,
        radius: size / 2 - dot / 2 - 1,
        segments: micro ? 12 : 32,
        // Stacked, the layers reach about 80% opacity next to the dot.
        layerOpacity: micro ? 0.13 : 0.05,
        trailScale: micro ? 0.65 : 1,
    };
};

const TrailSegment = ({
    index,
    shape,
    history,
    head,
    engine,
    colors,
}: {
    index: number;
    shape: Geometry;
    history: SharedValue<History>;
    head: SharedValue<{ x: number; y: number; t: number }>;
    engine: SharedValue<Engine>;
    colors: DotColors;
}) => {
    const props = useAnimatedProps(() => {
        const points = history.value;
        const now = head.value.t;
        const trailMs = engine.value.trailMs * shape.trailScale;
        // Every layer starts at the dot and reaches a little further back in time than the one before. Stacked,
        // the faint layers add up to a trail that is strongest at the dot and thins out along its path, with
        // no seams between pieces.
        const reach = ((index + 1) / shape.segments) * trailMs;
        let d = `M${head.value.x.toFixed(2)} ${head.value.y.toFixed(2)}`;
        let count = 0;
        for (let i = points.length - 3; i >= 0; i -= 3) {
            d += `L${points[i].toFixed(2)} ${points[i + 1].toFixed(2)}`;
            count += 1;
            if (now - points[i + 2] > reach) break;
        }
        const along = index / Math.max(1, shape.segments - 1);
        const base = interpolateColor(along, [0, 1], [colors.lavender, colors.periwinkle]);
        const accent = engine.value.accent === ACCENT_CORAL ? colors.coral : colors.peach;
        const mix = engine.value.accent === ACCENT_NONE ? 0 : engine.value.accentMix;
        return {
            d: count > 0 ? d : "M0 0",
            stroke: interpolateColor(mix, [0, 1], [base, accent]),
            strokeOpacity: count > 0 ? shape.layerOpacity : 0,
            strokeWidth: shape.dot * (0.84 - 0.66 * along),
        };
    });
    return <AnimatedPath animatedProps={props} fill="none" strokeLinecap="round" strokeLinejoin="round" />;
};

/**
 * The Dot: Conscious's mascot. A single dot whose state shows only in how it moves and the soft trail it
 * leaves. Pass the assistant's real state as `mood`; the dot moves from wherever it is into the new expression.
 */
export const Dot = ({
    size = 64,
    mood = "idle",
    reduceMotion,
}: {
    size?: number;
    mood?: DotMood;
    /** Defaults to the phone's Reduce Motion setting. */
    reduceMotion?: boolean;
}) => {
    const colors = useDotColors();
    const systemReduced = useReducedMotion();
    const still = reduceMotion ?? systemReduced;
    const shape = geometry(size);
    const center = size / 2;

    const engine = useSharedValue<Engine>(newEngine());
    const requested = useSharedValue(MOODS.indexOf(mood));
    const history = useSharedValue<History>([]);
    const head = useSharedValue({ x: center, y: center, t: 0 });

    useEffect(() => {
        requested.value = MOODS.indexOf(mood);
    }, [mood, requested]);

    const frames = useFrameCallback((frame) => {
        "worklet";
        // An absolute clock: the callback restarts its own when the component re-renders.
        const now = frame.timestamp;
        engine.modify((state) => {
            "worklet";
            if (state.since === 0) {
                state.since = now;
                state.wpAt = now + 1_800;
            }
            setMood(state, requested.value, now);
            step(state, now, frame.timeSincePreviousFrame ?? 16);
            return state;
        }, false);
        const x = center + engine.value.x * shape.radius;
        const y = center + engine.value.y * shape.radius;
        const last = history.value.length - 3;
        const moved = last < 0 || Math.hypot(history.value[last] - x, history.value[last + 1] - y) > 0.3;
        // Points are only kept while the dot moves, so a resting dot's trail fades out on its own.
        history.modify((points) => {
            "worklet";
            if (moved) points.push(x, y, now);
            const oldest = Math.max(now - HISTORY_MS, engine.value.trailStart);
            let drop = 0;
            while (drop < points.length && points[drop + 2] < oldest) drop += 3;
            if (drop) points.splice(0, drop);
            return points;
        });
        head.value = { x, y, t: now };
    }, false);

    useEffect(() => {
        frames.setActive(!still);
    }, [still, frames]);

    const dotProps = useAnimatedProps(() => ({ cx: head.value.x, cy: head.value.y }));

    return (
        <View
            style={{ width: size, height: size }}
            accessible
            accessibilityRole="image"
            accessibilityLabel={LABELS[mood]}
        >
            {still ? (
                <Svg key="still" width={size} height={size}>
                    <StillCue mood={mood} shape={shape} colors={colors} />
                    <Circle cx={center} cy={center} r={shape.dot / 2} fill={colors.dot} />
                </Svg>
            ) : (
                <Svg key="moving" width={size} height={size}>
                    {/* Longest, faintest layer first, so the colour nearest the dot sits on top. */}
                    {Array.from({ length: shape.segments }, (_, i) => shape.segments - 1 - i).map((index) => (
                        <TrailSegment
                            key={index}
                            index={index}
                            shape={shape}
                            history={history}
                            head={head}
                            engine={engine}
                            colors={colors}
                        />
                    ))}
                    <AnimatedCircle animatedProps={dotProps} r={shape.dot / 2} fill={colors.dot} />
                </Svg>
            )}
        </View>
    );
};

/** With Reduce Motion on the dot stays put; a soft ring fades in and out instead of the dot moving. */
const StillCue = ({ mood, shape, colors }: { mood: DotMood; shape: Geometry; colors: DotColors }) => {
    const opacity = useSharedValue(0);

    useEffect(() => {
        const fade = (to: number, duration: number) =>
            withTiming(to, { duration, easing: Easing.inOut(Easing.quad), reduceMotion: ReduceMotion.Never });
        switch (mood) {
            case "thinking":
                opacity.value = withRepeat(withSequence(fade(0.7, 900), fade(0.2, 900)), -1);
                break;
            case "confirmed":
            case "error":
                opacity.value = withSequence(
                    fade(0.85, 200),
                    withTiming(0.85, { duration: 700, reduceMotion: ReduceMotion.Never }),
                    fade(0, 600),
                );
                break;
            case "awaiting":
                opacity.value = fade(0.55, 300);
                break;
            default:
                opacity.value = fade(0, 300);
        }
    }, [mood, opacity]);

    const props = useAnimatedProps(() => ({ strokeOpacity: opacity.value }));
    const color = mood === "confirmed" ? colors.peach : mood === "error" ? colors.coral : colors.lavender;
    return (
        <AnimatedCircle
            animatedProps={props}
            cx={shape.size / 2}
            cy={shape.size / 2}
            r={shape.dot * 1.15}
            stroke={color}
            strokeWidth={Math.max(2, shape.dot * 0.35)}
            fill="none"
        />
    );
};
