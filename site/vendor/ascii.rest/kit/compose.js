import { EMPTY, INK, MAX, NONE, Surface, and, asPiece, bayer, chained, checkMeta, code, colorOf as inkOf, fail, hash, isHex, mergePalettes, piece, ramps, rgb, sample, valueNoise, } from "./core.js";
import { mirror } from "./mirror.js";
const ANCHORS = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"];
const SIDES = ["left", "right", "up", "down"];
// A value as an error message shows it.
const shown = (v) => typeof v === "function"
    ? "a function"
    : typeof v === "string"
        ? JSON.stringify(v)
        : Array.isArray(v)
            ? `[${v.map(shown).join(", ")}]`
            : v !== null && typeof v === "object"
                ? "an object"
                : String(v);
// Words as a sentence offers them: "a, b or c".
const or = (words) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words.at(-1)}` : (words[0] ?? ""));
const finite = (v) => typeof v === "number" && Number.isFinite(v);
// What an option must be, each with the error that says so. Each returns the default when the option is left out.
function whole(v, name, least, dflt) {
    if (v === undefined)
        return dflt;
    if (!Number.isInteger(v) || v < least)
        fail(`${name} takes a whole number of ${least} or more, not ${shown(v)}`);
    return v;
}
function duration(v, name, dflt, zero = false) {
    if (v === undefined)
        return dflt;
    if (!finite(v) || (zero ? v < 0 : v <= 0))
        fail(`${name} takes a number of seconds ${zero ? "of 0 or more" : "above 0"}, not ${shown(v)}`);
    return v;
}
function oneOf(v, name, list, dflt) {
    if (v === undefined)
        return dflt;
    if (!list.includes(v))
        fail(`${name} takes ${or(list.map((w) => JSON.stringify(w)))}, not ${shown(v)}`);
    return v;
}
// An options object, checked for keys it does not take, so a misspelt one throws instead of doing nothing.
function object(v, name, keys) {
    if (v === undefined)
        return {};
    if (v === null || typeof v !== "object" || Array.isArray(v))
        fail(`${name} takes an object of options, not ${shown(v)}`);
    if (keys)
        for (const [k, val] of Object.entries(v))
            if (val !== undefined && !keys.includes(k))
                fail(`${name} has no option ${JSON.stringify(k)}: it takes ${and(keys)}`);
    return v;
}
// A name or a note: one line of words, as screen readers, titles and svg() read them.
const oneLine = (v) => typeof v === "string" && !!v.trim() && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
// A whole's own name and note, when its options give them, checked.
function naming(fn, o) {
    if (o.name !== undefined && !oneLine(o.name))
        fail(`${fn}()'s name takes one line, such as "dashboard", not ${shown(o.name)}`);
    if (o.note !== undefined && !(oneLine(o.note) && o.note.length <= 72))
        fail(`${fn}()'s note takes one line of 1 to 72 characters saying what you see, not ${shown(o.note)}`);
    return { ...(o.name !== undefined ? { name: o.name.trim() } : {}), ...(o.note !== undefined ? { note: o.note } : {}) };
}
// A whole's own loop, when its options give one: its time then wraps round on it, as repeat() does, whatever its parts.
function loopOption(fn, v) {
    if (v === undefined)
        return undefined;
    if (!finite(v) || v < 0.05 || v > 60)
        fail(`${fn}()'s loop takes seconds from 0.05 to 60, the loop it plays round on, not ${shown(v)}`);
    return Math.round(v * 100) / 100;
}
// What a clip takes, and a step or a layer besides.
const CLIP = ["src", "options", "offset", "speed", "color"];
// A colour for both themes or one for each, as a list of one or two: null when it is left out.
function colorOf(v, name) {
    if (v === undefined)
        return null;
    if (isHex(v))
        return [v];
    if (v !== null && typeof v === "object" && isHex(v.light) && isHex(v.dark))
        return [v.light, v.dark];
    // A palette's name: its strong colour on each page.
    if (typeof v === "string") {
        const c = inkOf(v, name);
        return [c.light, c.dark];
    }
    return fail(`${name} takes #rrggbb, { light, dark }, or a palette's name such as "ocean", not ${shown(v)}`);
}
const isPiece = (v) => v !== null && typeof v === "object" && "meta" in v && typeof v.default === "function";
const isClip = (v) => v !== null && typeof v === "object" && !(v instanceof Surface) && "src" in v && !("meta" in v);
// A piece file imported whole, `import * as scene from "./scene.ts"`, is its default export.
const unwrap = (v) => v !== null && typeof v === "object" && !("meta" in v) && !("src" in v) && isPiece(v.default) ? v.default : v;
// A short name for a block of text: its first line, in quotes.
const textName = (text) => {
    const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
    return line ? `"${line.slice(0, 24)}"` : "text";
};
function prepare(fn, v, keys = CLIP) {
    v = unwrap(v);
    if (isClip(v))
        object(v, `${fn}()'s part`, keys);
    const clip = isClip(v) ? v : { src: v };
    // Text read from a file written on Windows ends its lines with \r\n: a newline all the same.
    const given = unwrap(clip.src);
    const src = (typeof given === "string" ? given.replace(/\r\n?/g, "\n") : given);
    if (!(typeof src === "string" || src instanceof Surface || isPiece(src)))
        fail(`${fn}() takes pieces, text, Surfaces or { src } clips, not ${shown(src)}`);
    // A cell holds one UTF-16 unit, so an emoji would be cut in two by a crop, a flip or a layer's edge.
    if (typeof src === "string" && /[\ud800-\udfff]/.test(src))
        fail(`text takes characters from the Basic Multilingual Plane, one a cell, so not emoji: ${JSON.stringify(src.slice(0, 24))}`);
    const p = asPiece(src, typeof src === "string" ? textName(src) : "drawing");
    if (clip.options !== undefined && (clip.options === null || typeof clip.options !== "object" || Array.isArray(clip.options)))
        fail(`a clip's options take an object of the piece's options, not ${shown(clip.options)}`);
    const offset = clip.offset === undefined ? 0 : finite(clip.offset) ? clip.offset : fail(`a clip's offset takes a number of seconds, not ${shown(clip.offset)}`);
    const speed = clip.speed === undefined ? 1 : finite(clip.speed) && clip.speed > 0 ? clip.speed : fail(`a clip's speed takes a number above 0, not ${shown(clip.speed)}`);
    const tint = colorOf(clip.color, "a clip's color");
    const frames = src.frames === true;
    return { piece: p, meta: p.meta, options: { ...clip.options }, offset, speed, tint, stretch: 0, cols: p.meta.cols, rows: p.meta.rows, frames };
}
// Fits a part to the whole's cells, 2 widths tall or 1, by doubling or halving its rows, so it keeps its shape.
function fit(p, cell) {
    const own = p.meta.cell ?? 2;
    p.stretch = own === cell ? 0 : own > cell ? 1 : -1;
    p.rows = p.stretch > 0 ? p.meta.rows * 2 : p.stretch < 0 ? Math.ceil(p.meta.rows / 2) : p.meta.rows;
    return p;
}
// A list of parts, fitted to the first one's cells.
function list(fn, parts, keys = CLIP) {
    if (!Array.isArray(parts) || !parts.length)
        fail(`${fn}() takes a list of one or more parts: pieces, text, Surfaces or { src } clips`);
    const all = parts.map((v) => prepare(fn, v, keys));
    for (const p of all)
        fit(p, all[0].meta.cell ?? 2);
    return all;
}
// How far apart two colours look, roughly, green counting most: core's measure, for folding colours together.
const apart = (a, b) => 0.3 * (a[0] - b[0]) ** 2 + 0.59 * (a[1] - b[1]) ** 2 + 0.11 * (a[2] - b[2]) ** 2;
/**
 * The parts' colours as one palette (a clip's own colour in place of its source's), then `extra` colours the whole
 * draws with (a border's). `plain` when the whole also draws something with no colour, which a coloured whole then
 * draws in INK rather than its first colour.
 *
 * Up to 64 colours this is mergePalettes(). Past 64, which a gradient banner over a scene comes to, the two colours
 * that look most alike are folded into one, the earlier part's kept, until 64 are left: a gradient loses a few of its
 * steps rather than the whole failing.
 */
function merge(parts, extra = [], plain = false) {
    const lists = parts.map((p) => p.tint ?? p.meta.palette);
    if (extra.length)
        lists.push(extra);
    if (plain)
        lists.push(undefined);
    try {
        return mergePalettes(lists);
    }
    catch {
        // Every colour once, in order, as mergePalettes() lists them, and INK when a part has none.
        const all = [];
        const seen = new Map();
        const add = (c) => {
            const k = c.toLowerCase();
            if (!seen.has(k))
                seen.set(k, all.push(c) - 1);
            return seen.get(k);
        };
        const idx = lists.map((p) => (p ?? []).map(add));
        const inked = lists.some((p) => !p) ? { light: add(INK.light), dark: add(INK.dark) } : null;
        const n = all.length;
        const values = all.map(rgb);
        // Each colour's stand-in: itself, or the earlier colour it was folded into.
        const into = all.map((_, i) => i);
        const alive = new Uint8Array(n).fill(1);
        // Each live colour's nearest live colour, the first of equals, and how far. The closest pair is the nearest of them
        // all; a fold keeps the earlier colour as it was, so only colours whose nearest was the one dropped look again.
        // Hundreds of colours fold in milliseconds rather than seconds, to the same palette.
        const near = new Int32Array(n), gap = new Float64Array(n);
        const look = (i) => {
            let best = Infinity, at = -1;
            for (let j = 0; j < n; j++)
                if (j !== i && alive[j]) {
                    const d = apart(values[i], values[j]);
                    if (d < best)
                        (best = d), (at = j);
                }
            near[i] = at;
            gap[i] = best;
        };
        for (let i = 0; i < n; i++)
            look(i);
        for (let left = n; left > 64; left--) {
            let a = -1;
            for (let i = 0; i < n; i++)
                if (alive[i] && (a < 0 || gap[i] < gap[a]))
                    a = i;
            const keep = Math.min(a, near[a]), drop = Math.max(a, near[a]);
            alive[drop] = 0;
            for (let i = 0; i < n; i++)
                if (into[i] === drop)
                    into[i] = keep;
            for (let i = 0; i < n; i++)
                if (alive[i] && near[i] === drop)
                    look(i);
        }
        const kept = into.filter((v, i) => v === i);
        const at = new Map(kept.map((c, i) => [c, i]));
        const to = (i) => at.get(into[i]);
        return {
            palette: kept.map((i) => all[i]),
            maps: idx.map((list) => Uint8Array.from(list, to)),
            ink: inked && { light: to(inked.light), dark: to(inked.dark) },
        };
    }
}
// The categories whose pieces repeat on a period an option sets, as svg() finds their loop.
const LOOPS = { logos: "shine", companies: "shine", distros: "scan" };
// A part's period in the whole's seconds: 0 for a still, undefined for one that never repeats exactly, as one held on
// its first frame by a negative offset does not.
function period(p) {
    const { meta } = p;
    if (!meta.fps)
        return 0;
    if (p.offset < 0)
        return undefined;
    let loop = meta.loop;
    if (loop === undefined && LOOPS[meta.category]) {
        const every = { ...meta.options, ...p.options }[LOOPS[meta.category]];
        if (finite(every) && every > 0)
            loop = every;
    }
    return loop === undefined ? undefined : loop / p.speed;
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
/**
 * The loop of things played together, by the kit's time rule: the least common multiple of their periods, on
 * hundredths of a second, when it is 60 seconds or less. None when one never repeats, when a period is not a whole
 * number of hundredths, or when it comes to more. Stills (0) count as repeating on any period.
 */
function together(periods) {
    let l = 0;
    for (const p of periods) {
        if (p === 0)
            continue;
        if (p === undefined)
            return undefined;
        const h = Math.round(p * 100);
        if (h < 1 || Math.abs(h - p * 100) > 1e-6)
            return undefined;
        l = l ? (l / gcd(l, h)) * h : h;
        if (l > 6000)
            return undefined;
    }
    return l ? l / 100 : undefined;
}
// A loop of one part slowed down, kept by the same rule: 60 seconds or less, else none (svg() then plays 4 seconds).
const playable = (loop) => (loop && loop <= 60 ? loop : undefined);
// The moment to hold still for reduced motion: the latest any part names, in the whole's time, so a typed banner
// shows every letter.
function stillOf(parts) {
    let at;
    for (const p of parts)
        if (p.meta.still !== undefined && p.meta.fps) {
            const s = (p.meta.still - p.offset) / p.speed;
            if (s >= 0 && (at === undefined || s > at))
                at = s;
        }
    return at || undefined;
}
// The ground the parts that have one agree on; none when two differ.
function groundOf(parts) {
    let g;
    for (const { meta } of parts)
        if (meta.ground) {
            if (g === undefined)
                g = meta.ground;
            else if (g.toLowerCase() !== meta.ground.toLowerCase())
                return undefined;
        }
    return g;
}
const fpsOf = (parts) => Math.max(0, ...parts.map((p) => p.meta.fps));
const categoryOf = (parts) => (parts.every((p) => p.meta.category === parts[0].meta.category) ? parts[0].meta.category : "generative");
// A note of one line, cut to the 72 characters a note may have.
const short = (s) => (s.length > 72 ? s.slice(0, 71) + "…" : s);
// A part's own options with the caller's on top, for a whole made of one part that takes them in its place.
const optionsOf = (p) => (p.meta.options !== undefined || Object.keys(p.options).length ? { ...p.meta.options, ...p.options } : undefined);
// The whole as a piece: checked for size, in the merged colours, its drawing set up once a play with that play's
// options.
function build(fn, w, m, setup) {
    if (w.cols > MAX.cols || w.rows > MAX.rows)
        fail(`${fn}() makes a piece ${w.cols} by ${w.rows}, past the ${MAX.cols} by ${MAX.rows} a piece can be: use fewer or smaller parts, or less room between them`);
    return piece({
        name: w.name,
        note: w.note ?? short(w.name),
        category: w.category,
        cols: w.cols,
        rows: w.rows,
        fps: w.fps,
        ...(w.cell === 1 ? { cell: 1 } : {}),
        ...(w.ground ? { ground: w.ground } : {}),
        ...(w.loop ? { loop: w.loop } : {}),
        ...(w.still ? { still: w.still } : {}),
        ...(w.clock ? { clock: true } : {}),
        ...(w.options ? { options: w.options } : {}),
        ...(m.palette.length ? { palette: m.palette } : {}),
        ...(m.ink ? { ink: m.ink } : {}),
    }, { setup });
}
// --- playing a part ------------------------------------------------------------------------
// Doubles a grid's rows into `out` (k 1), or halves them (k -1), keeping a row's cell where the one above it is empty.
function restretch(g, out, k) {
    const { cols } = g;
    for (let r = 0; r < out.rows; r++)
        for (let c = 0; c < cols; c++) {
            let i;
            if (k > 0)
                i = (r >> 1) * cols + c;
            else {
                i = 2 * r * cols + c;
                if (g.chars[i] === EMPTY && 2 * r + 1 < g.rows)
                    i += cols;
            }
            out.chars[r * cols + c] = g.chars[i];
            out.colors[r * cols + c] = g.colors[i];
        }
}
/**
 * One play of a part: its grid at the whole's time t, its rows fitted to the whole's cells, its colours turned into the
 * whole's, or all its clip's colour. The grid is the same one each call.
 */
function player(p, map, options = p.options) {
    const sampler = sample(p.piece, options);
    const fitted = p.stretch ? new Surface(p.cols, p.rows) : null;
    // The clip's colour in the whole's palette, on paper and on a dark page.
    const tint = p.tint && map ? [map[0], map[p.tint.length - 1]] : null;
    return (t, paper, mono) => {
        // A clip with a colour of its own is played in one ink, then drawn in that colour.
        const g = sampler.at(Math.max(0, t * p.speed + p.offset), { paper, mono: mono || !!tint });
        if (tint && !mono) {
            const k = tint[paper ? 0 : 1], { chars, colors } = g;
            for (let i = 0; i < chars.length; i++)
                if (chars[i] !== EMPTY)
                    colors[i] = k;
        }
        else if (map && !mono) {
            const c = g.colors;
            for (let i = 0; i < c.length; i++)
                if (c[i] !== NONE)
                    c[i] = map[c[i]] ?? NONE;
        }
        if (!fitted)
            return g;
        restretch(g, fitted, p.stretch);
        return fitted;
    };
}
// Where a box w by h sits in one W by H, by an anchor, `margin` in from the edges the anchor puts it against.
function place(anchor, W, H, w, h, margin = 0) {
    const x = anchor.endsWith("left") ? margin : anchor.endsWith("right") ? W - w - margin : Math.floor((W - w) / 2);
    const y = anchor.startsWith("top") ? margin : anchor.startsWith("bottom") ? H - h - margin : Math.floor((H - h) / 2);
    return [x, y];
}
const LAYER = [...CLIP, "anchor", "margin", "move", "x", "y", "mask", "halo"];
// A layer's move, checked: a side, or { to, period }. A period of 0 is one not given, which stack() fits to the parts.
function travel(v) {
    if (v === undefined)
        return null;
    const sides = or(SIDES.map((d) => JSON.stringify(d)));
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
        if (!SIDES.includes(v))
            fail(`a layer's move takes ${sides}, or { to, period }, not ${shown(v)}`);
        return { to: v, period: 0 };
    }
    const o = v;
    if (!SIDES.includes(o.to))
        fail(`a layer's move.to takes ${sides}, not ${shown(o.to)}`);
    return { to: o.to, period: duration(o.period, "a layer's move period", 0) };
}
// A position, a number or a function of t, checked: a function is called at t = 0 now, so a bad one fails at once.
function position(v, name) {
    if (v === undefined)
        return 0;
    if (typeof v === "function") {
        const at0 = v(0);
        if (!finite(at0))
            fail(`a layer's ${name} as a function takes t and returns a number, not ${shown(at0)} at t = 0`);
        return v;
    }
    if (!finite(v))
        fail(`a layer's ${name} takes a number of cells, or a function of t that returns one, not ${shown(v)}`);
    return v;
}
function layerOf(fn, v, anchor) {
    const p = prepare(fn, v, LAYER);
    const l = isClip(v) ? v : {};
    if (l.halo !== undefined && !(Number.isInteger(l.halo) && l.halo >= 0 && l.halo <= 4))
        fail(`a layer's halo takes a whole number of cells from 0 to 4, not ${shown(l.halo)}`);
    let mask = " ";
    if (l.mask === null)
        mask = null;
    else if (l.mask !== undefined) {
        if (typeof l.mask !== "string" || l.mask.length !== 1)
            fail(`a layer's mask takes one character, or null for none, not ${shown(l.mask)}`);
        code(l.mask);
        mask = l.mask;
    }
    return {
        ...p,
        x: position(l.x, "x"),
        y: position(l.y, "y"),
        anchor: oneOf(l.anchor, "a layer's anchor", ANCHORS, anchor),
        margin: whole(l.margin, "a layer's margin", 0, 0),
        move: travel(l.move),
        mask,
        halo: l.halo,
    };
}
// Clears the cells round a layer's ink, `h` cells out across and half that down (a cell is about twice as tall as it
// is wide), to blanks that cover what is under them: a knockout, so words read over a busy picture.
function knockout(s, g, x, y, h, mask) {
    const dy = Math.max(1, Math.round(h / 2));
    const blank = 32;
    for (let r = 0; r < g.rows; r++)
        for (let c = 0; c < g.cols; c++) {
            const ch = g.chars[r * g.cols + c];
            if (ch === EMPTY || ch === mask)
                continue;
            for (let j = r - dy; j <= r + dy; j++)
                for (let i = c - h; i <= c + h; i++) {
                    const k = s.index(x + i, y + j);
                    if (k >= 0)
                        s.put(k, blank);
                }
        }
}
// A position at t, in whole cells.
const at = (v, t) => {
    const n = typeof v === "function" ? v(t) : v;
    return finite(n) ? Math.floor(n) : 0;
};
// A place along a line `room` long that a box `size` long crosses, kept from just off its start to just off its end.
const around = (p, size, room) => {
    const span = room + size;
    return ((((p + size) % span) + span) % span) - size;
};
// Where a layer is at t, in a whole cols by rows: its anchor's spot, its margin in, its x and y, carried by its move.
function spot(l, t, cols, rows) {
    const [ax, ay] = place(l.anchor, cols, rows, l.cols, l.rows, l.margin);
    let x = ax + at(l.x, t), y = ay + at(l.y, t);
    if (l.move) {
        const { to, period } = l.move;
        const across = to === "left" || to === "right";
        // From where it starts, a whole crossing a period: the room it crosses and its own length, so it leaves entirely.
        // Multiplied before divided, so a whole number of cells a second lands on whole cells.
        const span = across ? cols + l.cols : rows + l.rows;
        const step = Math.floor((t * span) / period + 1e-9) * (to === "right" || to === "down" ? 1 : -1);
        if (across)
            x = around(x + step, l.cols, cols);
        else
            y = around(y + step, l.rows, rows);
    }
    return [x, y];
}
function stack(fn, all, given = {}) {
    const cell = all[0].meta.cell ?? 2;
    for (const l of all)
        fit(l, cell);
    const { cols, rows } = all[0];
    for (let i = 1; i < all.length; i++) {
        const l = all[i];
        // Words or a banner bigger than the stage, sitting still, would be cut at their edges with nothing said: "launch
        // day" read "AUNCH DA". Words that travel or are steered by a function cross the stage on purpose, and a picture
        // bigger than its stage is a window onto it.
        if (l.meta.category === "type" && !l.move && typeof l.x !== "function" && typeof l.y !== "function" && (l.cols > cols || l.rows > rows)) {
            const way = l.cols > cols ? `${l.cols} columns, wider than the ${cols}` : `${l.rows} rows, taller than the ${rows}`;
            fail(`${fn}(): ${l.meta.name} is ${way} of ${all[0].meta.name} under it, so its edges would be cut off. Make it smaller (banner() takes max: ${cols}, or a narrower font), crop() it, or lay it on something bigger`);
        }
        // Words and banners over a part that moves get a cell cleared round them, so they read.
        if (l.halo === undefined)
            l.halo = l.meta.category === "type" && all.slice(0, i).some((b) => b.meta.fps > 0) ? 1 : 0;
    }
    // A layer placed by a function moves on no period the kit can know: repeat() gives it one.
    const steered = all.some((l) => typeof l.x === "function" || typeof l.y === "function");
    // A move with no period of its own crosses in about 8 seconds: a whole number of the parts' loop when they have one
    // of 16 seconds or less (a part that never repeats aside), so the whole loops on the crossing alone.
    const theirs = together(all.map(period).filter((p) => p !== undefined));
    const fitted = theirs && theirs <= 16 ? Math.round(Math.max(1, Math.round(8 / theirs)) * theirs * 100) / 100 : 8;
    for (const l of all)
        if (l.move && !l.move.period)
            l.move.period = fitted;
    const travels = all.flatMap((l) => (l.move ? [l.move.period] : []));
    // The whole's own period, its crossings': 0 for none, undefined when they never come round together.
    const own = travels.length ? together(travels) : 0;
    const m = merge(all);
    const whole = {
        name: given.name ?? all.map((l) => l.meta.name).reverse().join(" over "),
        note: given.note,
        category: all[0].meta.category,
        cols,
        rows,
        cell,
        // A layer that moves needs frames even over stills.
        fps: Math.max(fpsOf(all), steered || travels.length ? 24 : 0),
        // A scene on a blank stage keeps its ground, so it is drawn for its own dark sky on a light page too.
        ground: groundOf(all),
        // By the kit's time rule: the crossings' period with the parts' loops, a part that never repeats counting as
        // repeating on the crossings'.
        loop: steered || own === undefined ? undefined : together([own, ...all.map((l) => period(l) ?? (own || undefined))]),
        still: stillOf(all),
        clock: all.some((l) => l.meta.clock),
    };
    return build(fn, whole, m, () => {
        const play = all.map((l, i) => player(l, m.maps[i]));
        return (t, s, ctx) => {
            for (let i = 0; i < all.length; i++) {
                const l = all[i];
                const g = play[i](t, ctx.paper, ctx.mono);
                const [x, y] = spot(l, t, cols, rows);
                // A card: its blank cells cover what is under them too.
                if (l.mask === null)
                    s.fill(" ", undefined, { x, y, cols: l.cols, rows: l.rows });
                else if (l.halo)
                    knockout(s, g, x, y, l.halo, l.mask === null ? -1 : l.mask.charCodeAt(0));
                s.paste(g, x, y, { mask: l.mask });
            }
        };
    });
}
/**
 * Pieces stacked, the first at the bottom, in the first one's size: each later one is laid over those before it, its
 * blank cells letting them show (see Layer's mask), at its anchor, margin and x, y on the first, travelling if it has a
 * move. Each keeps its own player, options and colours. A part made for character cells laid on a square grid (a
 * scene's, cell 1) has its rows doubled so it keeps its shape, and the other way round halved. The whole takes the ground
 * its parts agree on and the highest frame rate of the parts (24 at least when a layer moves). Its loop is the least common
 * multiple of the parts' and the moves' periods, within 60 seconds, a part that never repeats counting as repeating with
 * the moves; none when a layer moves by a function of t (wrap it in repeat()). For an empty stage of your own size, the
 * first part can be a blank grid: `new Surface(80, 24)`.
 *
 *   layer(starfield, { src: banner("hi"), anchor: "center" }, { src: "v1.0", anchor: "bottom-right", margin: 1 })
 *   layer(new Surface(80, 24), { src: donut, anchor: "left" }, { src: "<o>", color: "#fbbf24", move: "right" })
 */
export function layer(base, ...over) {
    return stack("layer", [base, ...over].map((v) => layerOf("layer", v, "top-left")));
}
/**
 * One piece over another, in the bottom one's size: a banner over a scene, a logo on a starfield. Centred by default;
 * `o` is a Layer's fields for the top piece, so { anchor: "top", margin: 2 } hangs it two rows below the top edge and
 * { anchor: "bottom", move: "left" } runs it along the bottom like a ticker.
 *
 *   over(banner("ascii.rest"), oceanSunset, { anchor: "top", margin: 12 })
 */
export function over(top, bottom, o = {}) {
    const { name, note, ...opts } = object(o, "over()", [...LAYER.filter((k) => k !== "src"), "name", "note"]);
    const upper = isClip(top) ? { ...opts, ...top } : { ...opts, src: top };
    return stack("over", [layerOf("over", bottom, "top-left"), layerOf("over", upper, "center")], naming("over", { name, note }));
}
const BOXES = { single: "┌┐└┘─│", double: "╔╗╚╝═║", rounded: "╭╮╰╯─│", heavy: "┏┓┗┛━┃", ascii: "++++-|" };
function borderOf(name, v) {
    if (v === undefined || v === false)
        return null;
    const o = v === true ? {} : v !== null && typeof v === "object" && !Array.isArray(v) ? v : fail(`${name} takes true, or { style, title, color, pad }, not ${shown(v)}`);
    object(o, name, ["style", "title", "color", "pad"]);
    const style = o.style ?? "rounded";
    const chars = typeof style === "string" && Object.hasOwn(BOXES, style) ? BOXES[style] : style;
    if (typeof chars !== "string" || chars.length !== 6 || /[\ud800-\udfff]/.test(chars))
        fail(`a border's style takes ${or(Object.keys(BOXES).map((k) => JSON.stringify(k)))}, or 6 characters of your own: top left, top right, bottom left, bottom right, across, down; not ${shown(style)}`);
    for (const ch of chars)
        code(ch);
    const title = o.title ?? false;
    if (typeof title !== "boolean" && typeof title !== "string")
        fail(`a border's title takes words, or true for the piece's name, not ${shown(title)}`);
    if (typeof title === "string")
        for (const ch of title)
            code(ch);
    const color = colorOf(o.color, "a border's color");
    const p = o.pad;
    const pad = p === undefined
        ? [0, 1]
        : typeof p === "number"
            ? [whole(p, "a border's pad", 0, 0), whole(p, "a border's pad", 0, 0)]
            : Array.isArray(p) && p.length === 2
                ? [whole(p[0], "a border's pad rows", 0, 0), whole(p[1], "a border's pad columns", 0, 0)]
                : fail(`a border's pad takes a number, or [rows, columns], not ${shown(p)}`);
    return { chars, title, color, pad };
}
// Draws a box's lines round a region, a title on its top edge, all in one colour.
function box(s, { x, y, cols: w, rows: h }, chars, title, color) {
    const [tl, tr, bl, br, across, down] = Array.from(chars, (ch) => ch.charCodeAt(0));
    const set = (cx, cy, ch) => {
        const i = s.index(cx, cy);
        if (i >= 0)
            s.put(i, ch, color);
    };
    for (let c = 1; c < w - 1; c++)
        set(x + c, y, across), set(x + c, y + h - 1, across);
    for (let r = 1; r < h - 1; r++)
        set(x, y + r, down), set(x + w - 1, y + r, down);
    set(x, y, tl), set(x + w - 1, y, tr), set(x, y + h - 1, bl), set(x + w - 1, y + h - 1, br);
    // After the corner and one line, with a space each side, leaving a line before the far corner; cut to fit with "…".
    if (title && w >= 7) {
        const room = w - 6;
        const words = ` ${title.length > room ? title.slice(0, room - 1).trimEnd() + "…" : title} `;
        for (let k = 0; k < words.length; k++)
            set(x + 2 + k, y, words.charCodeAt(k));
    }
}
// A box's title: the words given, or with `true` the piece's name, kept to what a cell holds, so an emoji or a newline
// in a name is left out rather than cut in two, and a block of text's own words, not its name in quotes.
const titleOf = (b, name) => b.title === true
    ? name.replace(/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]+/g, " ").replace(/\s+/g, " ").trim().replace(/^"(.+)"$/, "$1")
    : b.title || "";
// The palette index of a border's colour on paper and on a dark page, or null for the ink.
const borderInk = (m, at, b) => (b?.color ? [m.maps[at][0], m.maps[at][b.color.length - 1]] : null);
/**
 * A piece in a box: lines round it, `pad` blank cells inside them, and a title on the top edge if you like. It takes the
 * piece's options, as the piece does.
 *
 *   border(gauge, { title: "load", color: "#8b949e" })
 */
export function border(src, o = {}) {
    const fn = "border";
    const p = prepare(fn, src);
    const b = borderOf("border()", object(o, "border()"));
    const [py, px] = b.pad;
    const cols = p.cols + 2 * px + 2, rows = p.rows + 2 * py + 2;
    const m = merge([p], b.color ?? [], !b.color);
    const title = titleOf(b, p.meta.name);
    const boxed = build(fn, { ...single(p), cols, rows }, m, (options) => {
        const play = player(p, m.maps[0], options);
        const ink = borderInk(m, 1, b);
        return (t, s, ctx) => {
            box(s, { x: 0, y: 0, cols, rows }, b.chars, title, ctx.mono || !ink ? NONE : ink[ctx.paper ? 0 : 1]);
            s.paste(play(t, ctx.paper, ctx.mono), px + 1, py + 1);
        };
    });
    // A piece that plays once, a typed banner, still does in its box.
    return withMotion(boxed, playedOnce(p));
}
// Parts at fixed places in a whole of their own, with a box round each first when there is a border.
function arrange(fn, all, cols, rows, spots, name, own, boxes = [], b = null) {
    const m = merge(all, b?.color ?? [], boxes.length > 0 && !b?.color);
    const { name: given, note } = naming(fn, own);
    const loop = loopOption(fn, own.loop);
    const fps = fpsOf(all);
    const whole = {
        name: given ?? name,
        note,
        category: categoryOf(all),
        cols,
        rows,
        cell: all[0].meta.cell ?? 2,
        fps,
        ground: groundOf(all),
        // A loop of the whole's own wins: its time wraps round on it, so parts that would only meet past a minute repeat.
        loop: loop !== undefined ? (fps ? loop : undefined) : together(all.map(period)),
        still: stillOf(all),
        clock: all.some((p) => p.meta.clock),
    };
    return build(fn, whole, m, () => {
        const play = all.map((p, i) => player(p, m.maps[i]));
        const ink = borderInk(m, all.length, b);
        return (t, s, ctx) => {
            if (loop !== undefined)
                t -= loop * Math.floor(t / loop);
            const k = ctx.mono || !ink ? NONE : ink[ctx.paper ? 0 : 1];
            for (const bx of boxes)
                box(s, bx.region, b.chars, bx.title, k);
            for (let i = 0; i < all.length; i++)
                s.paste(play[i](t, ctx.paper, ctx.mono), spots[i][0], spots[i][1]);
        };
    });
}
/**
 * Pieces side by side, left to right, `gap` columns apart, each aligned in the row's height. Each keeps its own player,
 * options and colours.
 *
 *   row([rust, go, python], { gap: 4 })
 */
export function row(parts, o = {}) {
    const fn = "row";
    const opts = object(o, "row()", ["gap", "align", "loop", "name", "note"]);
    const gap = whole(opts.gap, "row's gap", 0, 2);
    const align = oneOf(opts.align, "row's align", ["top", "middle", "bottom"], "middle");
    const all = list(fn, parts);
    const rows = Math.max(...all.map((p) => p.rows));
    let x = 0;
    const spots = all.map((p) => {
        const y = align === "top" ? 0 : align === "bottom" ? rows - p.rows : Math.floor((rows - p.rows) / 2);
        const spot = [x, y];
        x += p.cols + gap;
        return spot;
    });
    return arrange(fn, all, x - gap, rows, spots, and(all.map((p) => p.meta.name)), opts);
}
/**
 * Pieces one above another, top to bottom, `gap` rows apart, each aligned in the column's width. Each keeps its own
 * player, options and colours.
 *
 *   column([banner("status"), uptimeBar])
 */
export function column(parts, o = {}) {
    const fn = "column";
    const opts = object(o, "column()", ["gap", "align", "loop", "name", "note"]);
    const gap = whole(opts.gap, "column's gap", 0, 1);
    const align = oneOf(opts.align, "column's align", ["left", "center", "right"], "center");
    const all = list(fn, parts);
    const cols = Math.max(...all.map((p) => p.cols));
    let y = 0;
    const spots = all.map((p) => {
        const x = align === "left" ? 0 : align === "right" ? cols - p.cols : Math.floor((cols - p.cols) / 2);
        const spot = [x, y];
        y += p.rows + gap;
        return spot;
    });
    return arrange(fn, all, cols, y - gap, spots, and(all.map((p) => p.meta.name)), opts);
}
/**
 * Pieces in a grid of `columns` a row: a dashboard. Cells line up, each column as wide as its widest part and each row
 * as tall as its tallest, `gap` apart, with a border round each if you like.
 *
 *   grid([lib.barChart, lib.gauge, lib.sparkline, lib.heartbeat], { border: { title: true } })   // two a row
 *   grid([gauge({ label: "cpu" }), sparkline({ label: "net" }), clockFace()], { columns: 3, name: "dashboard" })
 */
export function grid(parts, o = {}) {
    const fn = "grid";
    const opts = object(o, "grid()", ["columns", "gap", "align", "border", "loop", "name", "note"]);
    const all = list(fn, parts);
    const columns = whole(opts.columns, "grid's columns", 1, Math.ceil(Math.sqrt(all.length)));
    const g = opts.gap;
    const [gx, gy] = g === undefined
        ? [2, 1]
        : typeof g === "number"
            ? [whole(g, "grid's gap", 0, 0), whole(g, "grid's gap", 0, 0)]
            : Array.isArray(g) && g.length === 2
                ? [whole(g[0], "grid's gap columns", 0, 0), whole(g[1], "grid's gap rows", 0, 0)]
                : fail(`grid's gap takes a number, or [columns, rows], not ${shown(g)}`);
    const align = oneOf(opts.align, "grid's align", ANCHORS, "center");
    const b = borderOf("grid's border", opts.border);
    const n = Math.min(columns, all.length), lines = Math.ceil(all.length / n);
    const widths = Array.from({ length: n }, (_, j) => Math.max(...all.filter((_, i) => i % n === j).map((p) => p.cols)));
    const heights = Array.from({ length: lines }, (_, r) => Math.max(...all.slice(r * n, r * n + n).map((p) => p.rows)));
    // A border adds a line each side and its padding inside that.
    const [py, px] = b ? b.pad : [0, 0];
    const e = b ? 1 : 0;
    const cw = widths.map((w) => w + 2 * (px + e)), ch = heights.map((h) => h + 2 * (py + e));
    const xs = cw.map((_, j) => cw.slice(0, j).reduce((a, v) => a + v + gx, 0));
    const ys = ch.map((_, r) => ch.slice(0, r).reduce((a, v) => a + v + gy, 0));
    const spots = all.map((p, i) => {
        const j = i % n, r = Math.floor(i / n);
        // A part with a frame of its own sits in its cell's whole box, where the border would have been.
        if (b && p.frames) {
            const [dx, dy] = place(align, cw[j], ch[r], p.cols, p.rows);
            return [xs[j] + dx, ys[r] + dy];
        }
        const [dx, dy] = place(align, widths[j], heights[r], p.cols, p.rows);
        return [xs[j] + e + px + dx, ys[r] + e + py + dy];
    });
    const boxes = b
        ? all.flatMap((p, i) => {
            const j = i % n, r = Math.floor(i / n);
            return p.frames ? [] : [{ region: { x: xs[j], y: ys[r], cols: cw[j], rows: ch[r] }, title: titleOf(b, p.meta.name) }];
        })
        : [];
    const cols = xs[n - 1] + cw[n - 1], rows = ys[lines - 1] + ch[lines - 1];
    return arrange(fn, all, cols, rows, spots, and(all.map((p) => p.meta.name)), opts, boxes, b);
}
// --- one piece, reshaped --------------------------------------------------------------------
// The meta of a whole made of one part: the part's, its time as the part's speed and offset run it.
const single = (p) => ({
    name: p.meta.name,
    note: p.meta.note,
    category: p.meta.category,
    cols: p.cols,
    rows: p.rows,
    cell: p.meta.cell ?? 2,
    fps: p.meta.fps,
    ground: p.meta.ground,
    loop: playable(period(p)),
    still: p.meta.still !== undefined ? Math.max(0, (p.meta.still - p.offset) / p.speed) : undefined,
    clock: p.meta.clock,
    options: optionsOf(p),
});
/**
 * A source that plays once, as a typed banner does, still played once in a whole of it: from the whole's start to where
 * the source's play ends in the whole's time, the whole running it `lag` seconds late and `rate` times as fast before its
 * clip's own speed and offset. None for a source that doesn't play once, or one whose play ends past the minute an SVG
 * plays once in.
 */
function playedOnce(p, lag = 0, rate = 1) {
    const m = p.piece.motion;
    if (!m?.once || !finite(m.seconds) || !finite(m.from))
        return undefined;
    const end = lag + (m.from + m.seconds - p.offset) / (rate * p.speed);
    return end <= 60 ? { seconds: Math.max(0, end), from: 0, once: true } : undefined;
}
// A whole with the motion svg() reads, when it has one, as fx gives its effects theirs.
const withMotion = (whole, motion) => (motion ? Object.assign(whole, { motion }) : whole);
// A whole of one part, `cols` by `rows`, drawn from the part's grid each frame. It takes the part's options, and a part
// that plays once still does.
function reshape(fn, p, cols, rows, draw) {
    const m = merge([p]);
    const whole = build(fn, { ...single(p), cols, rows }, m, (options) => {
        const play = player(p, m.maps[0], options);
        return (t, s, ctx) => draw(play(t, ctx.paper, ctx.mono), s);
    });
    return withMotion(whole, playedOnce(p));
}
/**
 * A part of a piece: the cells of `region`, columns from x and rows from y, cut to the piece. Throws when the region
 * misses the piece.
 *
 *   crop(rust, { x: 16, y: 0, cols: 32, rows: 16 })   // the top of the cog
 */
export function crop(src, region) {
    const p = prepare("crop", src);
    if (region === null || typeof region !== "object")
        fail(`crop() takes a region, { x, y, cols, rows }, not ${shown(region)}`);
    const { x, y, cols, rows } = region;
    for (const [k, v] of [["x", x], ["y", y]])
        if (!Number.isInteger(v))
            fail(`crop's region.${k} takes a whole number, not ${shown(v)}`);
    for (const [k, v] of [["cols", cols], ["rows", rows]])
        if (!Number.isInteger(v) || v < 1)
            fail(`crop's region.${k} takes a whole number of 1 or more, not ${shown(v)}`);
    const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(p.cols, x + cols), y1 = Math.min(p.rows, y + rows);
    if (x1 <= x0 || y1 <= y0)
        fail(`crop's region, ${cols} by ${rows} at ${x}, ${y}, misses ${p.meta.name}, which is ${p.cols} by ${p.rows}`);
    return reshape("crop", p, x1 - x0, y1 - y0, (g, s) => s.paste(g, -x0, -y0));
}
/**
 * Blank cells round a piece: a number for every side, [rows, columns] (rows above and below, columns left and right),
 * or { top, right, bottom, left }, whole numbers. On a piece with a ground they are its ground.
 *
 *   pad(donut, [1, 4])
 */
export function pad(src, n) {
    const p = prepare("pad", src);
    let sides;
    if (typeof n === "number")
        sides = Array(4).fill(whole(n, "pad", 0, 0));
    else if (Array.isArray(n) && n.length === 2) {
        const [r, c] = [whole(n[0], "pad's rows", 0, 0), whole(n[1], "pad's columns", 0, 0)];
        sides = [r, c, r, c];
    }
    else if (n !== null && typeof n === "object" && !Array.isArray(n)) {
        const o = n;
        sides = ["top", "right", "bottom", "left"].map((k) => whole(o[k], `pad's ${k}`, 0, 0));
    }
    else
        return fail(`pad takes a number, [rows, columns] or { top, right, bottom, left }, not ${shown(n)}`);
    const [top, right, bottom, left] = sides;
    return reshape("pad", p, p.cols + left + right, p.rows + top + bottom, (g, s) => s.paste(g, left, top));
}
/**
 * A piece made bigger by whole numbers, each cell repeated `factor` times across and down (the nearest cell, no
 * smoothing), or [across, down]. Block art scales best: a "/" scaled is "//" over "//", not a longer slash.
 *
 *   scale(banner("hi", { pixel: 1 }), 3)
 */
export function scale(src, factor) {
    const p = prepare("scale", src);
    const [fx, fy] = typeof factor === "number"
        ? [whole(factor, "scale's factor", 1, 1), whole(factor, "scale's factor", 1, 1)]
        : Array.isArray(factor) && factor.length === 2
            ? [whole(factor[0], "scale's factor across", 1, 1), whole(factor[1], "scale's factor down", 1, 1)]
            : fail(`scale takes a whole number of 1 or more, or [across, down], not ${shown(factor)}`);
    const cols = p.cols * fx, rows = p.rows * fy;
    return reshape("scale", p, cols, rows, (g, s) => {
        for (let y = 0; y < rows; y++) {
            const from = Math.floor(y / fy) * g.cols;
            for (let x = 0, i = y * cols; x < cols; x++, i++) {
                const k = from + Math.floor(x / fx);
                s.put(i, g.chars[k], g.colors[k]);
            }
        }
    });
}
/**
 * A piece mirrored: "x" left to right, "y" upside down, "both" turned half round. Characters with a mirror image turn
 * into it, so / becomes \, ( becomes ), ┌ becomes ┐ or └, ▀ becomes ▄, and braille's dots move; the rest stay as they
 * are, so words read backwards.
 *
 *   row([rust, flip(rust, "x")])
 */
export function flip(src, axis) {
    const p = prepare("flip", src);
    if (axis === undefined)
        fail(`flip() takes an axis: "x" mirrors it left to right, "y" turns it upside down, "both" does both`);
    const ax = oneOf(axis, "flip's axis", ["x", "y", "both"], "x");
    const fx = ax !== "y", fy = ax !== "x";
    const { cols, rows } = p;
    return reshape("flip", p, cols, rows, (g, s) => {
        const m = mirror();
        for (let y = 0; y < rows; y++)
            for (let x = 0; x < cols; x++) {
                const k = (fy ? rows - 1 - y : y) * cols + (fx ? cols - 1 - x : x);
                let ch = g.chars[k];
                if (fx)
                    ch = m.x[ch];
                if (fy)
                    ch = m.y[ch];
                s.put(y * cols + x, ch, g.colors[k]);
            }
    });
}
const TRANSITIONS = ["cut", "dissolve", "fade", "wipe"];
// Each cell's moment in a dissolve, 0 to 1: smooth noise in patches about six cells across, a little grain, spread
// evenly by rank so the dissolve runs at an even pace from start to end.
function thresholds(cols, rows, aspect, seed) {
    const n = cols * rows;
    const raw = new Float64Array(n);
    for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++)
            raw[y * cols + x] = 0.8 * valueNoise(x * 0.17, y * 0.17 * aspect, seed) + 0.2 * hash(x, y, seed, 7);
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => raw[a] - raw[b]);
    const th = new Float32Array(n);
    order.forEach((i, rank) => (th[i] = (rank + 0.5) / n));
    return th;
}
// The ramps a fade steps a character down, and for every character its ramp and its place on it, built when the first
// fade is made: the blocks, eighths and dots down their own ramps, anything else down the standard ramp from the step that
// has about as much ink as it does, so a thin line only thins and never thickens first. ASCII is placed by the detailed
// ramp, which orders it by ink; box drawing is a thin line; braille goes by its dots; other characters sit midway. The
// ramps are read when the first fade is made, not when this file loads, as core's pieces chain through compose and core
// may load second.
let fades = null;
function fadeTable() {
    if (fades)
        return fades;
    const FADES = [ramps.blocks, ramps.eighths, ramps.dots, ramps.standard];
    const ramp = new Uint8Array(65536).fill(3), level = new Uint8Array(65536).fill(5);
    const top = ramps.standard.length - 1, ink = ramps.detailed;
    const put = (c, r, l) => ((ramp[c] = r), (level[c] = l));
    for (let c = 0; c <= 32; c++)
        level[c] = 0;
    for (let i = 1; i < ink.length; i++)
        put(ink.charCodeAt(i), 3, Math.max(1, Math.round((i / (ink.length - 1)) * top)));
    for (let c = 0x2500; c <= 0x257f; c++)
        put(c, 3, 3);
    for (let k = 1; k < 256; k++) {
        let dots = 0;
        for (let b = k; b; b >>= 1)
            dots += b & 1;
        put(0x2800 + k, 3, Math.max(1, Math.round((dots / 8) * top)));
    }
    // Blocks that fill part of a cell, by how much: a quarter, a half, three quarters.
    for (const [chars, l] of [["▖▗▘▝", 1], ["▀▌▐▚▞", 2], ["▙▛▜▟", 3]])
        for (const ch of chars)
            put(ch.charCodeAt(0), 0, l);
    // Each ramp's own characters, the earlier ramps last so they win: █ fades through ▓▒░, not ▇▆▅.
    for (let k = FADES.length - 1; k >= 0; k--)
        for (let i = 1; i < FADES[k].length; i++)
            put(FADES[k].charCodeAt(i), k, i);
    return (fades = { ramp, level, ramps: FADES });
}
const EDGE = 0.07; // how much of a dissolve's run a cell takes to cross, its edge drawn meanwhile
const EDGES = ".:"; // a dissolve's edge: about to go, just come
const BAND = "░▒▓"; // a wipe's band, the next step's side first
/**
 * Pieces one after another, `seconds` each, each turning into the next with a transition at the end of its time, and
 * by default round again. The whole is the size of the largest step, each centred in it. Each step's time starts when
 * it first shows, so an animated one runs on through its transition; the steps' colours are merged. The loop is the
 * steps' seconds added up.
 *
 *   sequence([rust, go, python], { seconds: 3 })                 // logos dissolving into each other
 *   sequence([{ src: banner("hello"), seconds: 2 }, donut], { transition: "wipe" })
 */
export function sequence(steps, o = {}) {
    const fn = "sequence";
    const opts = object(o, "sequence()", ["seconds", "transition", "overlap", "loop", "seed", "name", "note"]);
    const given = naming(fn, opts);
    const each = duration(opts.seconds, "sequence's seconds", 4);
    const transition = oneOf(opts.transition, "sequence's transition", TRANSITIONS, "dissolve");
    const overlap = duration(opts.overlap, "sequence's overlap", 0.8, true);
    const loop = opts.loop ?? true;
    if (typeof loop !== "boolean")
        fail(`sequence's loop takes true or false, not ${shown(loop)}`);
    const seed = opts.seed ?? 1;
    if (!Number.isInteger(seed))
        fail(`sequence's seed takes a whole number, not ${shown(seed)}`);
    const all = list(fn, steps, [...CLIP, "seconds"]);
    const n = all.length;
    const span = all.map((_, i) => {
        const v = steps[i];
        return duration(isClip(v) ? v.seconds : undefined, `step ${i + 1}'s seconds`, each);
    });
    const asked = transition === "cut" ? 0 : overlap;
    span.forEach((d, i) => {
        if (d < asked)
            fail(`sequence's overlap, ${asked} seconds, is longer than step ${i + 1}'s ${d}: a transition happens inside the step it leaves, so give it less overlap or more seconds`);
    });
    // A still turning into itself would only flash its edge, so one still step cuts back to itself.
    const ov = n === 1 && !all[0].meta.fps ? 0 : asked;
    const start = span.map((_, i) => span.slice(0, i).reduce((a, v) => a + v, 0));
    const total = start[n - 1] + span[n - 1];
    const cols = Math.max(...all.map((p) => p.cols)), rows = Math.max(...all.map((p) => p.rows));
    const cell = all[0].meta.cell ?? 2;
    // A step is shown from its transition in (none for the first, unless it loops), so its time runs from then.
    const into = (i) => (i > 0 || loop ? ov : 0);
    // Held still: the first step's own still moment, or the last one's when it does not loop, inside its time alone.
    const held = loop ? 0 : n - 1;
    const ph = all[held];
    const own = ph.meta.still !== undefined && ph.meta.fps ? (ph.meta.still - ph.offset) / ph.speed : 0;
    const still = start[held] + Math.max(0, Math.min(own - into(held), loop ? span[held] - ov - 0.01 : Infinity));
    // One step with nothing to turn into, or that cuts back to itself (repeat()), moves only if the step does.
    const alone = n === 1 && (!ov || !loop);
    const m = merge(all, [], transition === "wipe");
    const th = transition === "dissolve" ? thresholds(cols, rows, cell, seed) : null;
    const fading = transition === "fade" ? fadeTable() : null;
    const fps = Math.max(fpsOf(all), alone ? 0 : 24);
    const whole = {
        name: given.name ?? all.map((p) => p.meta.name).join(", then "),
        note: given.note,
        category: categoryOf(all),
        cols,
        rows,
        cell,
        fps,
        ground: groundOf(all),
        // A still has no loop to play.
        loop: loop && fps ? total : undefined,
        still: Math.max(0, still),
        clock: all.some((p) => p.meta.clock),
    };
    return build(fn, whole, m, () => {
        const play = all.map((p, i) => player(p, m.maps[i]));
        const a = new Surface(cols, rows), b = new Surface(cols, rows);
        const show = (i, t, into, ctx) => {
            const g = play[i](t, ctx.paper, ctx.mono);
            into.paste(g, Math.floor((cols - g.cols) / 2), Math.floor((rows - g.rows) / 2));
        };
        return (t, s, ctx) => {
            const tt = loop ? t - total * Math.floor(t / total) : t;
            let i = 0;
            while (i < n - 1 && tt >= start[i + 1])
                i++;
            const local = tt - start[i] + into(i);
            // When this step starts turning into the next: never for the last one when it does not loop.
            const leave = ov > 0 && (loop || i < n - 1) ? start[i] + span[i] - ov : Infinity;
            if (tt < leave)
                return show(i, local, s, ctx);
            a.clear();
            b.clear();
            show(i, local, a, ctx);
            show((i + 1) % n, tt - leave, b, ctx);
            const k = (tt - leave) / ov;
            const ac = a.chars, bc = b.chars, acol = a.colors, bcol = b.colors;
            if (th) {
                // Each cell turns over at its moment; for a short while either side of it, an edge in the colour of what is there.
                const front = -EDGE + k * (1 + 2 * EDGE);
                for (let c = 0; c < th.length; c++) {
                    const d = th[c] - front;
                    if (d < -EDGE)
                        s.put(c, bc[c], bcol[c]);
                    else if (d >= EDGE)
                        s.put(c, ac[c], acol[c]);
                    else if (ac[c] === EMPTY && bc[c] === EMPTY)
                        s.put(c, EMPTY);
                    else if (d < 0)
                        s.put(c, EDGES.charCodeAt(1), bc[c] !== EMPTY ? bcol[c] : acol[c]);
                    else
                        s.put(c, EDGES.charCodeAt(0), ac[c] !== EMPTY ? acol[c] : bcol[c]);
                }
            }
            else if (fading) {
                // The first half thins this step down its ramp to nothing, the second thickens the next up from nothing.
                const [g, gc] = k < 0.5 ? [ac, acol] : [bc, bcol];
                const f = k < 0.5 ? 2 * k : 2 - 2 * k;
                for (let y = 0, c = 0; y < rows; y++)
                    for (let x = 0; x < cols; x++, c++) {
                        const ch = g[c];
                        if (ch === EMPTY)
                            continue;
                        const level = fading.level[ch];
                        const step = Math.max(0, Math.min(level, Math.round(level * (1 - f) + bayer(x, y))));
                        s.put(c, step >= level ? ch : step <= 0 ? EMPTY : fading.ramps[fading.ramp[ch]].charCodeAt(step), gc[c]);
                    }
            }
            else {
                // A band leaning like a slash sweeps left to right, the next step behind it.
                const slant = 0.25 * cell;
                const front = k * (cols + (rows - 1) * slant + BAND.length) - BAND.length;
                for (let y = 0, c = 0; y < rows; y++)
                    for (let x = 0; x < cols; x++, c++) {
                        const u = x + y * slant - front;
                        if (u < 0)
                            s.put(c, bc[c], bcol[c]);
                        else if (u < BAND.length)
                            s.put(c, BAND.charCodeAt(Math.floor(u)));
                        else
                            s.put(c, ac[c], acol[c]);
                    }
            }
        };
    });
}
/**
 * A source with its time changed: `time` takes the whole's t to the source's, before its clip's own speed and offset,
 * and `timing` gives the meta's frame rate, loop and still (left out, there are none). Frames pass straight through,
 * so its colours and everything else are the source's own, and it takes the source's options; a clip with a colour of
 * its own is drawn through a player instead, which paints it. `motion` is the one svg() plays, for a source that plays
 * once: playedOnce() in the new time.
 */
function retime(fn, p, time, timing, motion) {
    const given = Object.fromEntries(Object.entries(timing).filter(([, v]) => v !== undefined));
    if (p.tint) {
        const m = merge([p]);
        const painted = build(fn, { ...single(p), loop: undefined, still: undefined, ...given }, m, (options) => {
            const play = player(p, m.maps[0], options);
            return (t, s, ctx) => s.paste(play(time(t), ctx.paper, ctx.mono), 0, 0);
        });
        return withMotion(painted, motion);
    }
    const { loop: _loop, still: _still, ...rest } = p.meta;
    const options = optionsOf(p);
    const meta = checkMeta({ ...rest, ...(options ? { options } : {}), ...given });
    const retimed = chained({
        meta,
        default(o) {
            const frame = p.piece.default({ ...meta.options, ...o });
            return (t, env) => frame(Math.max(0, time(Number.isFinite(t) ? t : 0) * p.speed + p.offset), env);
        },
    });
    return withMotion(retimed, motion);
}
// The source's still moment in the whole's time, as its part's speed and offset run it.
const stillAt = (p) => (p.meta.still !== undefined ? Math.max(0, (p.meta.still - p.offset) / p.speed) : undefined);
/**
 * A piece played `factor` times as fast: 2 is twice as fast, 0.5 half. Its loop and still moment scale with it, a
 * logo's glint period too; a loop slowed past 60 seconds is dropped, by the kit's time rule, so svg() plays 4 seconds.
 *
 *   speed(donut, 0.5)
 */
export function speed(src, factor) {
    if (!finite(factor) || factor <= 0)
        fail(`speed takes a number above 0, 2 for twice as fast, not ${shown(factor)}`);
    const p = prepare("speed", src);
    const loop = period(p), still = stillAt(p);
    return retime("speed", p, (t) => t * factor, { loop: playable(loop ? loop / factor : undefined), still: still && still / factor }, playedOnce(p, 0, factor));
}
/**
 * A piece that waits `seconds` on its first frame before it plays. It no longer repeats exactly, so it has no loop; one
 * that plays once, a typed banner, still plays once, the wait first, so its SVG waits, types and holds.
 *
 *   delay(banner("hi", { effect: "type" }), 1)
 */
export function delay(src, seconds) {
    const wait = duration(seconds, "delay", 0, true);
    const p = prepare("delay", src);
    const still = stillAt(p);
    return retime("delay", p, (t) => t - wait, { still: still !== undefined ? still + wait : undefined }, playedOnce(p, wait));
}
/**
 * A piece's first `seconds` over and over, which becomes its loop: a loop for any piece, and the way to give one to a
 * layer that moves by a function.
 *
 *   repeat(starfield, 6)
 */
export function repeat(src, seconds) {
    const every = duration(seconds, "repeat", 1);
    const p = prepare("repeat", src);
    const still = stillAt(p);
    return retime("repeat", p, (t) => t - every * Math.floor(t / every), { loop: p.meta.fps ? every : undefined, still: still !== undefined && still < every ? still : undefined });
}
/**
 * A still of a piece: its frame at `at` seconds, held.
 *
 *   freeze(oceanSunset, 12)
 */
export function freeze(src, at) {
    const moment = duration(at, "freeze", 0, true);
    return retime("freeze", prepare("freeze", src), () => moment, { fps: 0 });
}
/**
 * A piece under another name, and another note and category if you like: what screen readers, titles and svg() call
 * it. A whole made here is otherwise named from its parts ("hello over ocean sunset"). Everything else is the piece's
 * own, a banner's motion included.
 *
 *   named(over(banner("hello"), starfield), "hello", { note: "hello among the stars" })
 */
export function named(src, name, o = {}) {
    const opts = object(o, "named()", ["note", "category"]);
    // A name and a note are one line each: screen readers, titles and svg() read them as one.
    const line = (v) => typeof v === "string" && !!v.trim() && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
    if (!line(name))
        fail(`named() takes a name, one line such as "hello", not ${shown(name)}`);
    if (opts.note !== undefined && !line(opts.note))
        fail(`named()'s note takes one line saying what you see, not ${shown(opts.note)}`);
    const p = prepare("named", src);
    // Played as it was, it keeps what else it carries, such as a banner's motion, which svg() reads, and its own loop.
    const asItWas = p.speed === 1 && !p.offset && !p.tint && !Object.keys(p.options).length;
    const renamed = retime("named", p, (t) => t, {
        fps: p.meta.fps,
        loop: asItWas ? p.meta.loop : playable(period(p)),
        still: stillAt(p),
        name: name.trim(),
        note: opts.note ?? short(name.trim()),
        category: opts.category ?? p.meta.category,
    }, playedOnce(p));
    return asItWas ? chained({ ...p.piece, meta: renamed.meta, default: renamed.default }) : renamed;
}
