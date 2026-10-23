// The paintings in the hero: public-domain works, shaded in characters by ascii.rest's drawing(),
// each hung on a dark canvas that resizes to it. A new one prints in from the top about every 3.3 seconds.
import { drawing } from "./vendor/ascii.rest/kit/image.js";

// Each painting has its own setting, so its subject reads at a glance.
// crop: [x, y, w, h] as fractions of the image. flip: shade the dark parts instead of the light ones (for a light picture).
// contrast and bright: applied before shading.
const PAINTINGS = [
  { key: "pearl", credit: "Johannes Vermeer, Girl with a Pearl Earring, c. 1665" },
  { key: "wave", credit: "Katsushika Hokusai, The Great Wave off Kanagawa, c. 1831", crop: [0, 0, 0.62, 1], flip: true },
  { key: "monalisa", credit: "Leonardo da Vinci, Mona Lisa, c. 1503–1517" },
  { key: "wanderer", credit: "Caspar David Friedrich, Wanderer above the Sea of Fog, c. 1818" },
  { key: "milkmaid", credit: "Johannes Vermeer, The Milkmaid, c. 1660" },
  { key: "vangogh", credit: "Vincent van Gogh, Self-Portrait with Grey Felt Hat, 1887" },
  { key: "whistler", credit: "James McNeill Whistler, Arrangement in Grey and Black No. 1, 1871" },
  { key: "rembrandt", credit: "Rembrandt van Rijn, Self-Portrait, 1659", contrast: 1.1, bright: 1.5 },
];
const RAMP = " .:-=+*#%@"; // a space first: the darkest parts stay empty, so the subject stands out
const HOLD = 2300; // ms a painting stays
const FADE = 1000; // ms the next one takes to print in
const BAND = 0.1; // the print head's width, in transition progress
const PAD_COLS = 2; // the canvas's margin around a painting, in cells
const PAD_ROWS = 1;

const hero = document.getElementById("hero");
const box = document.getElementById("art");
const canvasEl = document.getElementById("canvas");
const inkEl = document.getElementById("ink");
const headEl = document.getElementById("head");
const credit = box.nextElementSibling;
const creditEl = document.getElementById("credit");
const countEl = document.getElementById("count");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const oneColumn = matchMedia("(max-width: 900px)");

const st = { cur: -1, nxt: 0, start: 0, last: 0, held: false, busy: false, queued: null };
let grid = { cols: 0, rows: 0, cellW: 4.8, cellH: 9.6, center: false };
let keys = null; // when each cell's turn comes in a change
let frames = []; // each painting as rows of text, for the current grid
let rects = []; // each painting's canvas, in px within the box

const imgs = PAINTINGS.map((p) => {
  const im = new Image();
  im.src = `paintings/${p.key}.jpg`;
  return im;
});

// The box is placed by CSS (beside the text on wide screens, in the column on phones); this reads its size in cells.
function layout() {
  const r = box.getBoundingClientRect();
  const size = parseFloat(getComputedStyle(inkEl).fontSize) || 8;
  const c = document.createElement("canvas").getContext("2d");
  c.font = `${size}px "IBM Plex Mono", ui-monospace, monospace`; // the <pre>'s own stack, so cells line up even if the web font fails
  const cellW = c.measureText("M".repeat(20)).width / 20;
  const cellH = size * 1.2;
  return { cols: Math.floor(r.width / cellW), rows: Math.floor(r.height / cellH), cellW, cellH, center: oneColumn.matches };
}

// One painting as rows of text on the shared grid: flush right on wide screens, centred on phones.
function draw(i) {
  const p = PAINTINGS[i];
  const img = imgs[i];
  const [cx, cy, cw, ch] = p.crop ?? [0, 0, 1, 1];
  const sw = img.naturalWidth * cw;
  const sh = img.naturalHeight * ch;
  const s = Math.min((grid.cols * 4) / sw, (grid.rows * 8) / sh, 1); // about 2×4 image pixels per cell, twice over
  const c = document.createElement("canvas");
  c.width = Math.max(8, Math.round(sw * s));
  c.height = Math.max(8, Math.round(sh * s));
  const x = c.getContext("2d", { willReadFrequently: true });
  x.filter = `grayscale(1) ${p.flip ? "invert(1)" : ""} contrast(${p.contrast ?? 1.3}) brightness(${p.bright ?? 1})`;
  x.drawImage(img, img.naturalWidth * cx, img.naturalHeight * cy, sw, sh, 0, 0, c.width, c.height);
  const d = drawing(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height, {
    style: "shade", color: false, width: grid.cols - 2 * PAD_COLS, height: grid.rows - 2 * PAD_ROWS, invert: false, background: "keep", ramp: RAMP,
  });
  const padL = grid.center ? Math.floor((grid.cols - d.cols) / 2) : grid.cols - PAD_COLS - d.cols;
  const padT = Math.floor((grid.rows - d.rows) / 2);
  rects[i] = { x: (padL - PAD_COLS) * grid.cellW, y: (padT - PAD_ROWS) * grid.cellH, w: (d.cols + 2 * PAD_COLS) * grid.cellW, h: (d.rows + 2 * PAD_ROWS) * grid.cellH };
  const rows = [];
  for (let r = 0; r < grid.rows; r++) {
    const row = d.mono[r - padT];
    rows.push(row === undefined ? " ".repeat(grid.cols) : (" ".repeat(padL) + row).padEnd(grid.cols).slice(0, grid.cols)); // every row exactly grid.cols wide
  }
  return rows;
}
const frameOf = (i) => (frames[i] ??= draw(i));

// A change goes top to bottom with a ragged edge. Each cell's turn is fixed, so it changes exactly once: no flicker.
function makeKeys() {
  keys = new Float32Array(grid.cols * grid.rows);
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      let h = (r * 73856093) ^ (c * 19349663);
      h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
      h ^= h >>> 15;
      keys[r * grid.cols + c] = 0.72 * (r / grid.rows) + 0.28 * ((h >>> 0) / 4294967295);
    }
  }
}

// Paints a still painting, or a change from one to the next at progress p (cells under the print head go in the head layer).
function paint(from, to, p) {
  if (!to) {
    inkEl.textContent = from.join("\n");
    headEl.textContent = "";
    return;
  }
  const ink = [];
  const head = [];
  const C = grid.cols;
  for (let r = 0; r < grid.rows; r++) {
    let a = "";
    let b = "";
    const fr = from ? from[r] : null;
    const tr = to[r];
    for (let c = 0; c < C; c++) {
      const k = keys[r * C + c];
      if (k <= p - BAND) { a += tr[c] ?? " "; b += " "; }
      else if (k <= p) { a += " "; b += tr[c] ?? " "; }
      else { a += (fr && fr[c]) || " "; b += " "; }
    }
    ink.push(a);
    head.push(b);
  }
  inkEl.textContent = ink.join("\n");
  headEl.textContent = head.join("\n");
}

function label(i) {
  creditEl.textContent = `After ${PAINTINGS[i].credit}`;
  countEl.textContent = `${String(i + 1).padStart(2, "0")} / ${String(PAINTINGS.length).padStart(2, "0")}`;
  box.setAttribute("aria-label", `${PAINTINGS[i].credit}, drawn in characters`);
}

// The canvas moves and resizes to a painting, and its label follows it: gliding between paintings, jumping on a resize.
function hang(i, still) {
  frameOf(i);
  const r = rects[i];
  canvasEl.classList.toggle("still", !!still);
  Object.assign(canvasEl.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  credit.style.transition = still ? "none" : "";
  credit.style.bottom = "auto";
  credit.style.top = `${box.offsetTop + r.y + r.h + 14}px`;
}

function goTo(i) {
  if (i < 0) return;
  if (st.busy) { if (i !== st.nxt) st.queued = i; return; } // mid-change: go there right after
  if (i === st.cur) return;
  if (!imgs[i].complete || !imgs[i].naturalWidth) { imgs[i].decode().then(() => goTo(i), () => {}); return; } // not loaded yet
  hang(i, st.cur < 0 || reduced);
  st.nxt = i;
  st.busy = true;
  st.start = performance.now();
  if (reduced) { st.cur = i; st.busy = false; st.last = performance.now(); paint(frameOf(i)); label(i); }
}

function tick(now) {
  requestAnimationFrame(tick);
  if (!grid.cols) return;
  if (st.busy) {
    const p = (now - st.start) / FADE;
    const to = frameOf(st.nxt);
    const from = st.cur >= 0 ? frameOf(st.cur) : null;
    if (p > 0.5 && creditEl.dataset.i !== String(st.nxt)) { creditEl.dataset.i = String(st.nxt); label(st.nxt); }
    if (p >= 1 + BAND) {
      st.cur = st.nxt;
      st.busy = false;
      st.last = now;
      paint(to);
      if (st.queued !== null) { const q = st.queued; st.queued = null; goTo(q); }
    } else paint(from, to, p);
  } else if (!st.held && now - st.last > HOLD) goTo((st.cur + 1) % PAINTINGS.length);
}

function resize() {
  const g = layout();
  if (g.cols < 24 || g.rows < 12) return; // too small to draw anything
  if (g.cols !== grid.cols || g.rows !== grid.rows || g.center !== grid.center) {
    grid = g;
    makeKeys();
    frames = [];
    rects = [];
    if (st.cur >= 0 && !st.busy) paint(frameOf(st.cur));
  }
  const shown = st.busy ? st.nxt : st.cur; // mid-change, the canvas belongs to the painting coming in
  if (shown >= 0) hang(shown, true);
}

// With a mouse, hovering holds a painting; on touch, a tap just shows the next one.
if (matchMedia("(hover: hover)").matches) {
  box.addEventListener("mouseenter", () => { st.held = true; hero.classList.add("held"); });
  box.addEventListener("mouseleave", () => { st.held = false; st.last = performance.now(); hero.classList.remove("held"); });
}
box.addEventListener("click", () => goTo((st.cur + 1) % PAINTINGS.length));
// The conversation's suggestions pick a painting that goes with them.
document.addEventListener("show-painting", (e) => goTo(PAINTINGS.findIndex((p) => p.key === e.detail)));

let resizeTimer;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 120); }).observe(hero);

await Promise.all([imgs[0].decode(), document.fonts.load('8px "IBM Plex Mono"')]);
resize();
goTo(0); // the first one prints in from blank
requestAnimationFrame(tick);
document.fonts.ready.then(resize);
// The others are worked out in idle time, one at a time.
const idle = window.requestIdleCallback ?? ((f) => setTimeout(f, 60));
for (let i = 1; i < PAINTINGS.length; i++) {
  await imgs[i].decode();
  await new Promise((r) => idle(r));
  if (grid.cols) frameOf(i);
}
