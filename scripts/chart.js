/**
 * ULT's Session Rating — the trend chart.
 *
 * One SVG line chart: a line per criterion plus the overall average, one point
 * per finished session. Lines draw themselves in; the legend chips switch a
 * series on and off; hovering shows the values for the nearest session.
 * Drawn by hand instead of pulling in a chart library, so the module stays a
 * few plain files with no external dependency.
 */

import { SCALE, resolveCategories, formatDate, formatDateShort, formatScore, loc } from "./settings.js";
import { summarize } from "./store.js";
import { el, clamp } from "./dom.js";

const NS = "http://www.w3.org/2000/svg";
const W = 760;
const H = 320;
const PAD = { left: 38, right: 22, top: 18, bottom: 40 };

/** Series colours: the theme accent leads, the rest are fixed, distinct hues. */
const SERIES_COLORS = ["var(--ur-accent)", "#d8b463", "#7bbf8f", "#d97a6a", "#b48ad9"];
const OVERALL_COLOR = "var(--ur-text)";

function svg(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * @param {object[]} sessions finished sessions, oldest first
 * @returns {HTMLElement}
 */
export function buildChart(sessions) {
  const wrap = el("div", "ultrate-chart");

  if (sessions.length === 0) {
    wrap.appendChild(el("p", "ultrate-empty", {}, loc("ULTRATE.Hub.Dynamics.Empty")));
    return wrap;
  }

  // The newest session's own edits decide the legend names.
  const cats = resolveCategories(sessions.at(-1).cats);
  const series = [
    ...cats.map((cat, i) => ({ id: cat.id, name: cat.name, color: SERIES_COLORS[i], on: true })),
    { id: "overall", name: loc("ULTRATE.Hub.Dynamics.Overall"), color: OVERALL_COLOR, on: true, dashed: true }
  ];
  const summaries = sessions.map((s) => summarize(s));
  const valueOf = (s, i) => (s.id === "overall" ? summaries[i].overall : summaries[i].avg[s.id]);

  // --- legend ---------------------------------------------------------------
  const legend = el("div", "ultrate-legend");
  wrap.appendChild(legend);

  // --- svg ----------------------------------------------------------------
  const chart = el("div", "ultrate-chart-box");
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "ultrate-svg", role: "img", "aria-label": loc("ULTRATE.Hub.Tab.dynamics") });
  chart.appendChild(root);
  wrap.appendChild(chart);

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const xAt = (i) => PAD.left + (sessions.length === 1 ? plotW / 2 : (i / (sessions.length - 1)) * plotW);
  const yAt = (v) => PAD.top + (1 - (v - SCALE.min) / (SCALE.max - SCALE.min)) * plotH;

  // grid + y labels
  for (let v = SCALE.min; v <= SCALE.max; v++) {
    const major = v % 2 === 0 || v === SCALE.min;
    root.appendChild(svg("line", { x1: PAD.left, x2: W - PAD.right, y1: yAt(v), y2: yAt(v), class: `ultrate-grid-line${major ? " is-major" : ""}` }));
    if (major) {
      const label = svg("text", { x: PAD.left - 10, y: yAt(v) + 4, class: "ultrate-axis-y" });
      label.textContent = String(v);
      root.appendChild(label);
    }
  }

  // x labels: at most about eight, so they never collide
  const step = Math.max(1, Math.ceil(sessions.length / 8));
  sessions.forEach((s, i) => {
    if (i % step !== 0 && i !== sessions.length - 1) return;
    const label = svg("text", { x: xAt(i), y: H - PAD.bottom + 20, class: "ultrate-axis-x" });
    label.textContent = formatDateShort(s.date) || String(i + 1);
    root.appendChild(label);
  });

  // series layers
  const layers = new Map();
  for (const s of series) {
    const g = svg("g", { class: "ultrate-series", style: `--c:${s.color}` });
    const points = [];
    sessions.forEach((_, i) => {
      const v = valueOf(s, i);
      if (v !== null && v !== undefined) points.push({ i, v });
    });

    if (points.length > 1) {
      const d = points.map((p, k) => `${k === 0 ? "M" : "L"}${xAt(p.i).toFixed(1)} ${yAt(p.v).toFixed(1)}`).join(" ");
      g.appendChild(svg("path", { d, class: `ultrate-line${s.dashed ? " is-dashed" : ""}`, pathLength: 1 }));
    }
    for (const p of points) {
      g.appendChild(svg("circle", { cx: xAt(p.i), cy: yAt(p.v), r: s.dashed ? 3.5 : 4, class: "ultrate-dot-point" }));
    }
    root.appendChild(g);
    layers.set(s.id, g);
  }

  // hover guide + tooltip
  const guide = svg("line", { y1: PAD.top, y2: H - PAD.bottom, class: "ultrate-guide" });
  root.appendChild(guide);
  const hit = svg("rect", { x: PAD.left, y: PAD.top, width: plotW, height: plotH, fill: "transparent", class: "ultrate-hit" });
  root.appendChild(hit);

  const tip = el("div", "ultrate-chart-tip");
  chart.appendChild(tip);

  const showTip = (index) => {
    const s = sessions[index];
    const x = xAt(index);
    guide.setAttribute("x1", x);
    guide.setAttribute("x2", x);
    guide.classList.add("is-on");

    tip.replaceChildren(
      el("div", "ultrate-chart-tip-title", {}, s.title),
      el("div", "ultrate-chart-tip-date", {}, [formatDate(s.date), s.system].filter(Boolean).join(" · "))
    );
    for (const item of series) {
      if (!item.on) continue;
      const v = valueOf(item, index);
      const row = el("div", "ultrate-chart-tip-row");
      const swatch = el("span", "ultrate-swatch");
      swatch.style.background = item.color;
      row.append(swatch, el("span", "ultrate-chart-tip-name", {}, item.name), el("span", "ultrate-chart-tip-val", {}, formatScore(v)));
      tip.appendChild(row);
    }
    tip.classList.add("is-on");

    const box = chart.getBoundingClientRect();
    const px = (x / W) * box.width;
    const w = tip.offsetWidth;
    const left = px + 16 + w > box.width ? px - 16 - w : px + 16;
    tip.style.left = `${clamp(left, 4, Math.max(4, box.width - w - 4))}px`;
    tip.style.top = "8px";
  };
  const hideTip = () => {
    guide.classList.remove("is-on");
    tip.classList.remove("is-on");
  };

  hit.addEventListener("pointermove", (event) => {
    const box = root.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * W;
    let best = 0;
    let bestDist = Infinity;
    sessions.forEach((_, i) => {
      const dist = Math.abs(xAt(i) - x);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    showTip(best);
  });
  hit.addEventListener("pointerleave", hideTip);

  // legend chips
  for (const s of series) {
    const chip = el("button", "ultrate-legend-chip is-on", { type: "button", "aria-pressed": "true" });
    const swatch = el("span", "ultrate-swatch");
    swatch.style.background = s.color;
    chip.append(swatch, el("span", null, {}, s.name));
    chip.addEventListener("click", () => {
      s.on = !s.on;
      chip.classList.toggle("is-on", s.on);
      chip.setAttribute("aria-pressed", String(s.on));
      layers.get(s.id)?.classList.toggle("is-off", !s.on);
      hideTip();
    });
    legend.appendChild(chip);
  }

  if (sessions.length === 1) {
    wrap.appendChild(el("p", "notes", {}, loc("ULTRATE.Hub.Dynamics.OneSession")));
  }
  return wrap;
}
