/**
 * Render the headline chart as SVG: mean quality (y) against cost per 1,000 prompts (x, log scale).
 * Emphasis form: tiershift in the accent hue, the two fixed-model baselines in gray.
 * Writes chart-light.svg and chart-dark.svg. No dependencies, no network.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARMS, here, loadMeta, loadRows, summaries, type Arm } from "./lib.js";

type Theme = { name: "light" | "dark"; surface: string; text: string; text2: string; muted: string; grid: string; axis: string; accent: string; gray: string };
const THEMES: Theme[] = [
  { name: "light", surface: "#fcfcfb", text: "#0b0b0b", text2: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7", accent: "#2a78d6", gray: "#898781" },
  { name: "dark", surface: "#1a1a19", text: "#ffffff", text2: "#c3c2b7", muted: "#898781", grid: "#2c2c2a", axis: "#383835", accent: "#3987e5", gray: "#8a8983" },
];
const LABEL: Record<Arm, string> = { always_flagship: "Always flagship", always_fast: "Always fast", tiershift: "tiershift" };
const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function renderChart(t: Theme): string {
  const rows = loadRows(), meta = loadMeta(), S = summaries(rows);
  const W = 760, H = 440, m = { top: 84, right: 220, bottom: 64, left: 64 };
  const pw = W - m.left - m.right, ph = H - m.top - m.bottom;

  // x: cost per 1,000 prompts, log10. Ticks at powers of ten that bracket the data.
  const costs = ARMS.map((a) => S[a].per1k).filter((c) => c > 0);
  const lo = Math.floor(Math.log10(Math.min(...costs)) - 0.15), hi = Math.ceil(Math.log10(Math.max(...costs)) + 0.15);
  const x = (c: number) => m.left + ((Math.log10(c) - lo) / (hi - lo)) * pw;
  // y: mean quality on the full 1 to 5 scale. No truncation.
  const y = (q: number) => m.top + ph - ((q - 1) / 4) * ph;
  const fmtCost = (c: number) => (c >= 100 ? `$${c.toFixed(0)}` : c >= 10 ? `$${c.toFixed(1)}` : `$${c.toFixed(2)}`);
  const fmtTick = (c: number) => (c >= 1 ? `$${c.toFixed(0)}` : `$${c.toFixed(2).replace(/0+$/, "")}`);

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d" font-family='${FONT}'>\n`;
  s += `<title id="t">Quality against cost, three arms</title>\n<desc id="d">${esc(ARMS.map((a) => `${LABEL[a]}: quality ${S[a].quality.toFixed(2)}, ${fmtCost(S[a].per1k)} per 1,000 prompts`).join(". "))}.</desc>\n`;
  s += `<rect width="${W}" height="${H}" fill="${t.surface}"/>\n`;
  s += `<text x="${m.left}" y="34" fill="${t.text}" font-size="17" font-weight="600">Same ${meta.prompts} prompts. Same judge. Three ways to pick a model.</text>\n`;
  s += `<text x="${m.left}" y="56" fill="${t.text2}" font-size="12.5">Mean quality 1 to 5, judged blind by ${esc(meta.judge.split("/")[1])} · cost per 1,000 prompts, log scale · ${meta.date}</text>\n`;

  // gridlines and axes: hairline, solid, recessive
  for (let q = 1; q <= 5; q++) {
    s += `<line x1="${m.left}" x2="${m.left + pw}" y1="${y(q)}" y2="${y(q)}" stroke="${t.grid}" stroke-width="1"/>\n`;
    s += `<text x="${m.left - 10}" y="${y(q) + 4}" fill="${t.muted}" font-size="11.5" text-anchor="end">${q}</text>\n`;
  }
  for (let e = lo; e <= hi; e++) {
    const c = 10 ** e;
    s += `<line x1="${x(c)}" x2="${x(c)}" y1="${m.top}" y2="${m.top + ph}" stroke="${t.grid}" stroke-width="1"/>\n`;
    s += `<text x="${x(c)}" y="${m.top + ph + 20}" fill="${t.muted}" font-size="11.5" text-anchor="middle">${fmtTick(c)}</text>\n`;
  }
  s += `<line x1="${m.left}" x2="${m.left + pw}" y1="${m.top + ph}" y2="${m.top + ph}" stroke="${t.axis}" stroke-width="1"/>\n`;
  s += `<text x="${m.left + pw / 2}" y="${H - 22}" fill="${t.muted}" font-size="11.5" text-anchor="middle">Cost per 1,000 prompts (USD, log scale)</text>\n`;
  s += `<text transform="translate(18 ${m.top + ph / 2}) rotate(-90)" fill="${t.muted}" font-size="11.5" text-anchor="middle">Mean quality (1 to 5)</text>\n`;

  // marks: 12px dots with a 2px surface ring; tiershift in accent, baselines in gray
  const pts = ARMS.map((a) => ({ a, cx: x(S[a].per1k), cy: y(S[a].quality), color: a === "tiershift" ? t.accent : t.gray }));
  // Labels: right of the dot by default. Push apart vertically on collision. If a right-side label box
  // would cover another dot, flip that label to the left side instead.
  const LABEL_W = 170, LABEL_H = 34;
  const labels = pts.map((p) => ({ ...p, ly: p.cy, side: 1 as 1 | -1 })).sort((p, q) => p.ly - q.ly);
  // Push apart only when the label boxes would overlap in both axes. Far-apart dots keep their labels beside them.
  for (let i = 1; i < labels.length; i++) for (let j = 0; j < i; j++) {
    const a = labels[j], b = labels[i];
    if (Math.abs(a.cx - b.cx) < LABEL_W + 14 && b.ly - a.ly < LABEL_H) b.ly = a.ly + LABEL_H;
  }
  for (const l of labels) {
    const covers = (side: 1 | -1) => pts.some((o) => o.a !== l.a && (side === 1 ? o.cx > l.cx + 8 && o.cx < l.cx + 14 + LABEL_W : o.cx < l.cx - 8 && o.cx > l.cx - 14 - LABEL_W) && Math.abs(o.cy - l.ly) < LABEL_H);
    if (covers(1) && !covers(-1) && l.cx - 14 - LABEL_W > m.left) l.side = -1;
  }
  for (const p of pts) {
    s += `<circle cx="${p.cx}" cy="${p.cy}" r="8" fill="${t.surface}"/>\n<circle cx="${p.cx}" cy="${p.cy}" r="6" fill="${p.color}"/>\n`;
  }
  for (const l of labels) {
    const S1 = S[l.a], lx = l.cx + 14 * l.side, anchor = l.side === 1 ? "start" : "end";
    if (Math.abs(l.ly - l.cy) > 2) s += `<line x1="${l.cx + 8 * l.side}" y1="${l.cy}" x2="${lx - 3 * l.side}" y2="${l.ly - 4}" stroke="${t.axis}" stroke-width="1"/>\n`;
    s += `<text x="${lx}" y="${l.ly}" fill="${t.text}" font-size="13" font-weight="${l.a === "tiershift" ? 600 : 500}" text-anchor="${anchor}">${esc(LABEL[l.a])}</text>\n`;
    s += `<text x="${lx}" y="${l.ly + 16}" fill="${t.text2}" font-size="11.5" text-anchor="${anchor}">quality ${S1.quality.toFixed(2)} · ${fmtCost(S1.per1k)} per 1k</text>\n`;
  }
  // one-line read, bottom right of plot, in text tokens
  const fl = S.always_flagship, ts = S.tiershift;
  s += `<text x="${W - 24}" y="${H - 22}" fill="${t.text2}" font-size="11.5" text-anchor="end">tiershift: ${((ts.quality / fl.quality) * 100).toFixed(1)}% of flagship quality at ${((ts.cost / fl.cost) * 100).toFixed(0)}% of the cost</text>\n`;
  s += `</svg>\n`;
  return s;
}

for (const t of THEMES) { const p = join(here, `chart-${t.name}.svg`); writeFileSync(p, renderChart(t)); console.log(`wrote ${p}`); }
