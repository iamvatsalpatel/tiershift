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
const LABEL: Record<Arm, string> = { always_flagship: "Always flagship", always_mid: "Always mid", always_fast: "Always fast", tiershift: "tiershift" };
const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function renderChart(t: Theme): string {
  const rows = loadRows(), meta = loadMeta(), S = summaries(rows);
  const W = 800, H = 440, m = { top: 84, right: 230, bottom: 64, left: 64 };
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
  s += `<text x="${m.left}" y="34" fill="${t.text}" font-size="17" font-weight="600">The fast model matched the flagship. tiershift is the safety net.</text>\n`;
  s += `<text x="${m.left}" y="56" fill="${t.text2}" font-size="12.5">${meta.prompts} prompts · mean quality 1 to 5, judged blind by ${esc(meta.judge.split("/")[1])} · cost per 1,000 prompts, log scale · ${meta.date}</text>\n`;

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
  // Labels. Four points can crowd the top-right corner, so place each label by rule, not by push-apart:
  // the cheapest point labels to its right; the most expensive labels to its right; the two middle points
  // label below and above their dots, offset horizontally so the text never crosses another dot or label.
  const LABEL_H = 34;
  type Placed = { a: Arm; cx: number; cy: number; color: string; lx: number; ly: number; anchor: "start" | "end" | "middle"; leader: boolean };
  const byCost = [...pts].sort((p, q) => p.cx - q.cx);
  const placed: Placed[] = byCost.map((p, i) => {
    if (i === 0) return { ...p, lx: p.cx + 14, ly: p.cy, anchor: "start", leader: false };
    if (i === byCost.length - 1) return { ...p, lx: p.cx + 14, ly: p.cy, anchor: "start", leader: false };
    // middle points: stack below the plot's crowded corner, alternating rows
    const row = i; // 1 or 2
    return { ...p, lx: p.cx - 40 * (row - 1), ly: p.cy + LABEL_H * row + 6, anchor: "middle", leader: true };
  });
  // If a right-side label would run past the canvas, flip it to the left.
  for (const l of placed) if (l.anchor === "start" && l.lx + 175 > W - 12) { l.lx = l.cx - 14; l.anchor = "end"; }
  for (const p of pts) {
    s += `<circle cx="${p.cx}" cy="${p.cy}" r="8" fill="${t.surface}"/>\n<circle cx="${p.cx}" cy="${p.cy}" r="6" fill="${p.color}"/>\n`;
  }
  for (const l of placed) {
    const S1 = S[l.a];
    if (l.leader) s += `<line x1="${l.cx}" y1="${l.cy + 8}" x2="${l.lx}" y2="${l.ly - 14}" stroke="${t.axis}" stroke-width="1"/>\n`;
    s += `<text x="${l.lx}" y="${l.ly}" fill="${t.text}" font-size="13" font-weight="${l.a === "tiershift" ? 600 : 500}" text-anchor="${l.anchor}">${esc(LABEL[l.a])}</text>\n`;
    s += `<text x="${l.lx}" y="${l.ly + 16}" fill="${t.text2}" font-size="11.5" text-anchor="${l.anchor}">quality ${S1.quality.toFixed(2)} · ${fmtCost(S1.per1k)} per 1k</text>\n`;
  }
  // one-line read, bottom right of plot, in text tokens
  const fl = S.always_flagship, ts = S.tiershift;
  s += `<text x="${W - 24}" y="${H - 22}" fill="${t.text2}" font-size="11.5" text-anchor="end">tiershift: ${((ts.quality / fl.quality) * 100).toFixed(1)}% of flagship quality at ${((ts.cost / fl.cost) * 100).toFixed(0)}% of the cost</text>\n`;
  s += `</svg>\n`;
  return s;
}

for (const t of THEMES) { const p = join(here, `chart-${t.name}.svg`); writeFileSync(p, renderChart(t)); console.log(`wrote ${p}`); }
