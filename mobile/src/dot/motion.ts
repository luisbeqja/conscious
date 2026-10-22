/**
 * The Dot's motion engine. Every expression is a moving target the dot chases on a spring, so a change of
 * state always starts from where the dot is and how fast it is going: it never snaps or restarts.
 *
 * Positions are in units of the dot's play radius: 0 is the centre, 1 the edge of its space.
 */

export const MOODS = ["idle", "thinking", "confirmed", "error", "awaiting"] as const;
export type DotMood = (typeof MOODS)[number];

export const ACCENT_NONE = 0;
export const ACCENT_PEACH = 1;
export const ACCENT_CORAL = 2;

export interface Engine {
    x: number;
    y: number;
    vx: number;
    vy: number;
    mood: number;
    since: number;
    /** Where the dot was when the current expression began. */
    fromX: number;
    fromY: number;
    /** Idle drift: the spot the dot is heading to, and when it picks the next one. */
    wpX: number;
    wpY: number;
    wpAt: number;
    phase: number;
    trailMs: number;
    /** The trail ignores anything the dot drew before this moment. */
    trailStart: number;
    accent: number;
    accentMix: number;
}

export const newEngine = (): Engine => ({
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    mood: 0,
    since: 0,
    fromX: 0,
    fromY: 0,
    wpX: 0,
    wpY: 0,
    wpAt: 1_800,
    phase: 0,
    trailMs: 420,
    trailStart: 0,
    accent: ACCENT_NONE,
    accentMix: 0,
});

interface Pose {
    x: number;
    y: number;
    /** Spring stiffness and damping ratio: how eagerly the dot follows, and how much it overshoots. */
    k: number;
    zeta: number;
    trailMs: number;
    accent: number;
    accentOn: boolean;
}

const easeInOut = (t: number) => {
    "worklet";
    return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};
const easeOut = (t: number) => {
    "worklet";
    return 1 - (1 - t) ** 3;
};
const clamp01 = (t: number) => {
    "worklet";
    return Math.min(1, Math.max(0, t));
};
const lerp = (a: number, b: number, t: number) => {
    "worklet";
    return a + (b - a) * t;
};

/** A path through key points, each leg with its own duration and easing. */
const script = (
    t: number,
    points: number[][],
    legs: { ms: number; ease: (t: number) => number }[],
): { x: number; y: number; done: boolean } => {
    "worklet";
    let elapsed = t;
    for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        if (elapsed < leg.ms) {
            const p = leg.ease(clamp01(elapsed / leg.ms));
            return {
                x: lerp(points[i][0], points[i + 1][0], p),
                y: lerp(points[i][1], points[i + 1][1], p),
                done: false,
            };
        }
        elapsed -= leg.ms;
    }
    const last = points[points.length - 1];
    return { x: last[0], y: last[1], done: true };
};

const CHECK_LEAD_MS = 200;

// A check mark drawn by moving: down into the dip, then one decisive stroke up and to the right.
const CHECK = [
    [-0.42, -0.02],
    [-0.1, 0.36],
    [0.5, -0.42],
];

/** Where the dot wants to be right now, for each expression. */
const pose = (engine: Engine, now: number): Pose => {
    "worklet";
    const t = now - engine.since;
    switch (MOODS[engine.mood]) {
        // A compact orbit. It opens a little wider and settles in, which reads as curiosity turning into focus.
        case "thinking": {
            const radius = 0.42 + 0.3 * Math.exp(-t / 600);
            const angle = engine.phase + (t / 1_700) * Math.PI * 2;
            const wobble = 0.04 * Math.sin(t / 900);
            return {
                x: radius * Math.cos(angle) + wobble,
                y: radius * 0.86 * Math.sin(angle),
                k: 120,
                zeta: 0.85,
                trailMs: 540,
                accent: ACCENT_NONE,
                accentOn: false,
            };
        }
        case "confirmed": {
            const at = script(
                t,
                [[engine.fromX, engine.fromY], ...CHECK],
                [
                    { ms: CHECK_LEAD_MS, ease: easeOut },
                    { ms: 200, ease: easeInOut },
                    { ms: 320, ease: easeOut },
                ],
            );
            return { x: at.x, y: at.y, k: 420, zeta: 0.74, trailMs: 620, accent: ACCENT_PEACH, accentOn: t < 1_100 };
        }
        // Starts to go, stops short, pauses, then steps back. No bounce: a problem, not a performance.
        case "error": {
            const reach = [lerp(engine.fromX, 0.38, 0.75), lerp(engine.fromY, 0, 0.75)];
            const at = script(
                t,
                [[engine.fromX, engine.fromY], reach, reach, [-0.1, 0.14]],
                [
                    { ms: 210, ease: easeOut },
                    { ms: 380, ease: easeOut },
                    { ms: 700, ease: easeInOut },
                ],
            );
            return { x: at.x, y: at.y, k: 220, zeta: 1, trailMs: 380, accent: ACCENT_CORAL, accentOn: t < 2_200 };
        }
        // Mostly still, with one small questioning loop every few seconds.
        case "awaiting": {
            const cycle = (t + 3_200) % 3_800;
            const rest = [0.04, -0.06];
            const loop = 0.17;
            if (cycle < 1_150) {
                const angle = Math.PI / 2 + easeInOut(cycle / 1_150) * Math.PI * 2;
                return {
                    x: rest[0] + loop * Math.cos(angle),
                    y: rest[1] - loop + loop * Math.sin(angle),
                    k: 90,
                    zeta: 0.8,
                    trailMs: 500,
                    accent: ACCENT_NONE,
                    accentOn: false,
                };
            }
            return { x: rest[0], y: rest[1], k: 40, zeta: 0.9, trailMs: 500, accent: ACCENT_NONE, accentOn: false };
        }
        default:
            return {
                x: engine.wpX,
                y: engine.wpY,
                k: 14,
                zeta: 0.92,
                trailMs: 420,
                accent: ACCENT_NONE,
                accentOn: false,
            };
    }
};

/** Idle drift: pick a nearby spot now and then, often drift home, and rest in between. */
const drift = (engine: Engine, now: number) => {
    "worklet";
    if (now < engine.wpAt) return;
    const home = Math.random() < 0.35 || Math.hypot(engine.x, engine.y) > 0.35;
    const angle = Math.random() * Math.PI * 2;
    const radius = home ? Math.random() * 0.06 : 0.14 + Math.random() * 0.24;
    engine.wpX = radius * Math.cos(angle);
    engine.wpY = radius * Math.sin(angle) * 0.8;
    // A small sideways push turns a straight glide into a loose arc.
    const dx = engine.wpX - engine.x;
    const dy = engine.wpY - engine.y;
    const side = (Math.random() < 0.5 ? -1 : 1) * 0.35;
    engine.vx += -dy * side;
    engine.vy += dx * side;
    engine.wpAt = now + 3_000 + Math.random() * 3_000;
};

/** Switch expression, keeping the dot's position and speed. */
export const setMood = (engine: Engine, mood: number, now: number) => {
    "worklet";
    if (mood === engine.mood) return;
    engine.mood = mood;
    engine.since = now;
    engine.fromX = engine.x;
    engine.fromY = engine.y;
    engine.phase = Math.atan2(engine.y, engine.x);
    if (MOODS[mood] === "idle") {
        // Hold where it landed for a beat, then drift home.
        engine.wpX = engine.x;
        engine.wpY = engine.y;
        engine.wpAt = now + 1_200;
    }
};

/** Advance the dot by one frame. */
export const step = (engine: Engine, now: number, dtMs: number) => {
    "worklet";
    const mood = MOODS[engine.mood];
    if (mood === "idle") drift(engine, now);
    // The glide into position is not part of the check mark, so the trail starts where the stroke does.
    if (mood === "confirmed" && now - engine.since >= CHECK_LEAD_MS && engine.trailStart < engine.since) {
        engine.trailStart = now;
    }
    const target = pose(engine, now);
    const dt = Math.min(dtMs, 48) / 1_000;
    // Semi-implicit Euler in small steps stays stable even for the stiff gestures.
    const steps = Math.max(1, Math.ceil(dt / 0.008));
    const h = dt / steps;
    const c = 2 * target.zeta * Math.sqrt(target.k);
    for (let i = 0; i < steps; i++) {
        engine.vx += (target.k * (target.x - engine.x) - c * engine.vx) * h;
        engine.vy += (target.k * (target.y - engine.y) - c * engine.vy) * h;
        engine.x += engine.vx * h;
        engine.y += engine.vy * h;
    }
    const ease = 1 - Math.exp(-dt / 0.25);
    engine.trailMs += (target.trailMs - engine.trailMs) * ease;
    if (target.accentOn) engine.accent = target.accent;
    engine.accentMix += ((target.accentOn ? 1 : 0) - engine.accentMix) * (1 - Math.exp(-dt / 0.3));
    if (engine.accentMix < 0.01 && !target.accentOn) engine.accent = ACCENT_NONE;
};
