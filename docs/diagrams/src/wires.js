// Draws a diagram's arrows between its boxes, once the fonts and pictures are in, then marks the page ready.
//
//   wire("#from", "#to", { out: "bottom", in: "top", at: [0.3, 0.5], align: "to", label: "your message", step: 1 });
//
// out, in: the sides the arrow leaves and enters. at: where on each side, 0 to 1 (one number for both).
// align: "from" or "to" keeps the arrow straight by moving the other end. both: a head at each end.
// label, step: text and a numbered badge, placed `labelAt` along the arrow, centred or on one side (labelSide).
(() => {
    const NS = "http://www.w3.org/2000/svg";
    const wires = [];
    window.wire = (from, to, options = {}) => wires.push({ from, to, ...options });

    const DIRECTION = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
    const flat = (side) => side === "left" || side === "right";

    function draw(main, svg, w) {
        const base = main.getBoundingClientRect();
        const box = (selector) => {
            const el = document.querySelector(selector);
            if (!el) throw new Error(`No element ${selector}`);
            const r = el.getBoundingClientRect();
            return { left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height };
        };
        const point = (b, side, at) => {
            if (side === "left") return [b.left, b.top + b.height * at];
            if (side === "right") return [b.left + b.width, b.top + b.height * at];
            if (side === "top") return [b.left + b.width * at, b.top];
            return [b.left + b.width * at, b.top + b.height];
        };
        const [atFrom, atTo] = Array.isArray(w.at) ? w.at : [w.at ?? 0.5, w.at ?? 0.5];
        const out = w.out ?? "right";
        const into = w.in ?? "left";
        let s = point(box(w.from), out, atFrom);
        let e = point(box(w.to), into, atTo);
        if (w.align === "from") e = flat(into) ? [e[0], s[1]] : [s[0], e[1]];
        if (w.align === "to") s = flat(out) ? [s[0], e[1]] : [e[0], s[1]];
        // a little air between an arrow and the box it touches
        const gap = (p, side, d) => [p[0] + DIRECTION[side][0] * d, p[1] + DIRECTION[side][1] * d];
        s = gap(s, out, w.both ? 5 : 2);
        e = gap(e, into, 5);

        let points;
        if (w.via) points = [s, ...w.via, e];
        else if (flat(out) && flat(into)) {
            const x = s[0] + (e[0] - s[0]) * (w.bend ?? 0.5);
            points = Math.abs(s[1] - e[1]) < 0.5 ? [s, e] : [s, [x, s[1]], [x, e[1]], e];
        } else if (!flat(out) && !flat(into)) {
            const y = s[1] + (e[1] - s[1]) * (w.bend ?? 0.5);
            points = Math.abs(s[0] - e[0]) < 0.5 ? [s, e] : [s, [s[0], y], [e[0], y], e];
        } else if (flat(out)) points = [s, [e[0], s[1]], e];
        else points = [s, [s[0], e[1]], e];

        // the line stops where the head begins
        const HEAD = 10;
        const shorten = (a, b, d) => {
            const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
            return [b[0] - ((b[0] - a[0]) / len) * d, b[1] - ((b[1] - a[1]) / len) * d];
        };
        const line = points.map((p) => [...p]);
        line[line.length - 1] = shorten(line[line.length - 2], line[line.length - 1], HEAD - 2);
        if (w.both) line[0] = shorten(line[1], line[0], HEAD - 2);

        // straight runs with rounded corners
        const R = 12;
        let d = `M${line[0][0]},${line[0][1]}`;
        for (let i = 1; i < line.length - 1; i++) {
            const [a, p, b] = [line[i - 1], line[i], line[i + 1]];
            const r = Math.min(R, Math.hypot(p[0] - a[0], p[1] - a[1]) / 2, Math.hypot(b[0] - p[0], b[1] - p[1]) / 2);
            const p1 = shorten(a, p, r);
            const p2 = shorten(b, p, r);
            d += ` L${p1[0]},${p1[1]} Q${p[0]},${p[1]} ${p2[0]},${p2[1]}`;
        }
        d += ` L${line[line.length - 1][0]},${line[line.length - 1][1]}`;
        const path = document.createElementNS(NS, "path");
        path.setAttribute("d", d);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", w.color ?? "#151513");
        path.setAttribute("stroke-width", w.width ?? 1.5);
        if (w.dashed) path.setAttribute("stroke-dasharray", "4 5");
        svg.append(path);

        const head = (tip, from) => {
            const len = Math.hypot(tip[0] - from[0], tip[1] - from[1]);
            const [ux, uy] = [(tip[0] - from[0]) / len, (tip[1] - from[1]) / len];
            const [bx, by] = [tip[0] - ux * HEAD, tip[1] - uy * HEAD];
            const polygon = document.createElementNS(NS, "polygon");
            polygon.setAttribute(
                "points",
                `${tip[0]},${tip[1]} ${bx - uy * 5.5},${by + ux * 5.5} ${bx + uy * 5.5},${by - ux * 5.5}`,
            );
            polygon.setAttribute("fill", w.color ?? "#151513");
            svg.append(polygon);
        };
        head(points[points.length - 1], points[points.length - 2]);
        if (w.both) head(points[0], points[1]);

        if (!w.label && !w.step) return;
        const at = path.getPointAtLength(path.getTotalLength() * (w.labelAt ?? 0.5));
        const label = document.createElement("div");
        label.className = `wire-label ${w.labelClass ?? ""}`;
        if (w.step) label.innerHTML = `<span class="step">${w.step}</span>`;
        if (w.label) label.insertAdjacentHTML("beforeend", `<span>${w.label}</span>`);
        const side = w.labelSide ?? "center";
        const shift = {
            center: "-50%, -50%",
            right: "0, -50%",
            left: "-100%, -50%",
            above: "-50%, -100%",
            below: "-50%, 0",
        }[side];
        const nudge = { center: [0, 0], right: [8, 0], left: [-8, 0], above: [0, -6], below: [0, 6] }[side];
        label.style.left = `${at.x + nudge[0]}px`;
        label.style.top = `${at.y + nudge[1]}px`;
        label.style.transform = `translate(${shift})`;
        main.append(label);
    }

    window.addEventListener("load", async () => {
        await document.fonts.ready;
        const main = document.querySelector("main");
        const svg = document.createElementNS(NS, "svg");
        svg.setAttribute("class", "wires");
        main.append(svg);
        const { width, height } = main.getBoundingClientRect();
        svg.setAttribute("width", width);
        svg.setAttribute("height", height);
        svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
        for (const w of wires) draw(main, svg, w);
        document.body.dataset.ready = "true";
    });
})();
