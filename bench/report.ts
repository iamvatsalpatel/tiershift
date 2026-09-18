/** Build results.md from results.jsonl. Pure aggregation, no network. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARMS, CATS, f2, here, loadMeta, loadRows, mean, money, pct, summaries } from "./lib.js";

const rows = loadRows();
const meta = loadMeta();

let md = `# Benchmark results\n\nRun date ${meta.date}. ${meta.prompts} prompts, 4 arms, max_tokens ${meta.max_tokens}. Primary judge \`${meta.judge}\`, second judge \`${meta.judge2 ?? "none"}\`. Both blind: they see the prompt and the answer, never the model.\n\n`;
md += `Arms: \`always_flagship\` = ${meta.flagship}, \`always_mid\` = ${meta.mid ?? "n/a"}, \`always_fast\` = ${meta.fast}, \`tiershift\` = the shipped default policy choosing among exactly those models plus ${meta.local ?? "a local model"}. One answer per (model, prompt) is shared across arms, so tiershift is judged on the same answer the fixed arm got. tiershift cost includes the Jev routing call and any failed attempt before a fallback.\n\n`;

md += `## Headline\n\n| Arm | Mean quality (1-5) | Share scored 4 or 5 | Total cost | Cost per 1,000 prompts | p50 latency | p95 latency | Judged | Empty answers |\n|---|---|---|---|---|---|---|---|---|\n`;
const S = summaries(rows);
for (const arm of ARMS) { const s = S[arm]; md += `| ${arm} | ${f2(s.quality)} | ${(s.q5 * 100).toFixed(0)}% | ${money(s.cost)} | ${money(s.per1k)} | ${Math.round(s.p50)} ms | ${Math.round(s.p95)} ms | ${s.n}/${s.total} | ${s.empty} |\n`; }
const fl = S.always_flagship, ts = S.tiershift, fa = S.always_fast, mi = S.always_mid;
const rel = (s: typeof fl) => `${((s.quality / fl.quality) * 100).toFixed(1)}% of flagship quality at ${((s.cost / fl.cost) * 100).toFixed(0)}% of flagship cost`;
md += `\n**Read:** tiershift: ${rel(ts)}. always_mid: ${rel(mi)}. always_fast: ${rel(fa)}.\n\n`;

md += `## Quality by category\n\n| Category | ${ARMS.join(" | ")} |\n|---|${ARMS.map(() => "---").join("|")}|\n`;
for (const c of CATS) md += `| ${c} | ${ARMS.map((a) => f2(mean(rows.filter((r) => r.arm === a && r.category === c && r.quality !== null).map((r) => r.quality as number)))).join(" | ")} |\n`;

md += `\n## Cost by category (total, USD)\n\n| Category | ${ARMS.join(" | ")} |\n|---|${ARMS.map(() => "---").join("|")}|\n`;
for (const c of CATS) md += `| ${c} | ${ARMS.map((a) => money(rows.filter((r) => r.arm === a && r.category === c).reduce((s, r) => s + (r.cost_usd ?? 0), 0))).join(" | ")} |\n`;

const routed = rows.filter((r) => r.arm === "tiershift" && !r.error);
const tiers = [...new Set(routed.map((r) => r.tier as string))];
const tierOrder = ["local", "fast", "mid", "flagship"].filter((t) => tiers.includes(t)).concat(tiers.filter((t) => !["local", "fast", "mid", "flagship"].includes(t)));
md += `\n## Where tiershift sent each category\n\nRows are the author's expected tier. Columns are the tier tiershift chose. Diagonal is agreement. Off-diagonal is not automatically wrong; see quality above.\n\n| expected \\ chosen | ${tierOrder.join(" | ")} | n |\n|---|${tierOrder.map(() => "---").join("|")}|---|\n`;
for (const c of CATS) { const rs = routed.filter((r) => r.category === c); md += `| ${c} (${rs[0]?.expected_tier ?? ""}) | ${tierOrder.map((t) => rs.filter((r) => r.tier === t).length).join(" | ")} | ${rs.length} |\n`; }
const agree = routed.filter((r) => r.tier === r.expected_tier).length;
md += `\nAgreement with author labels: ${agree}/${routed.length} (${((agree / (routed.length || 1)) * 100).toFixed(0)}%). Fell back to the next tier on ${routed.filter((r) => r.fell_back).length} prompts.\n`;

md += `\n## Models used by the tiershift arm\n\n| Model | Prompts | Mean quality | Total cost |\n|---|---|---|---|\n`;
for (const m of [...new Set(routed.map((r) => r.model))].sort()) { const rs = routed.filter((r) => r.model === m); md += `| ${m} | ${rs.length} | ${f2(mean(rs.filter((r) => r.quality !== null).map((r) => r.quality as number)))} | ${money(rs.reduce((s, r) => s + (r.cost_usd ?? 0), 0))} |\n`; }

const jevLat = routed.map((r) => r.jev_latency_ms);
md += `\n## Routing overhead\n\nJev call: p50 ${Math.round(pct(jevLat, 0.5))} ms, p95 ${Math.round(pct(jevLat, 0.95))} ms, total ${money(routed.reduce((s, r) => s + r.jev_cost_usd, 0))} for ${routed.length} routes (${money((routed.reduce((s, r) => s + r.jev_cost_usd, 0) / (routed.length || 1)) * 1000)} per 1,000).\n`;

const worst = routed.filter((r) => r.quality !== null).sort((a, b) => (a.quality as number) - (b.quality as number)).slice(0, 8);
md += `\n## Lowest-scoring routed answers\n\n| id | tier | model | score | judge note | difficulty | stakes |\n|---|---|---|---|---|---|---|\n`;
for (const r of worst) md += `| ${r.id} | ${r.tier} | ${r.model} | ${r.quality} | ${(r.judge_note ?? "").replace(/\|/g, "/")} | ${r.signals ? f2(r.signals.difficulty) : ""} | ${r.signals ? f2(r.signals.stakes) : ""} |\n`;

// Traffic-mix sensitivity: pure arithmetic on per-category means. No new calls.
const money5 = (x: number) => `$${x.toFixed(5)}`;
const perPromptCost: Record<string, Record<string, number>> = {};
const perPromptQ: Record<string, Record<string, number>> = {};
for (const c of CATS) {
  perPromptCost[c] = {}; perPromptQ[c] = {};
  for (const a of ARMS) {
    const rs = rows.filter((r) => r.arm === a && r.category === c && !r.error && r.quality !== null);
    perPromptCost[c][a] = rs.reduce((s, r) => s + (r.cost_usd ?? 0), 0) / (rs.length || 1);
    perPromptQ[c][a] = mean(rs.map((r) => r.quality as number));
  }
}
md += `\n## What the saving depends on: your traffic mix\n\nHard prompts cost about 100 times more than acknowledgements on every arm, so they dominate spend. Routing saves money in proportion to the share of easy traffic. Per-prompt mean cost from this run:\n\n| Category | always_flagship | always_fast | tiershift | tiershift vs flagship |\n|---|---|---|---|---|\n`;
for (const c of CATS) md += `| ${c} | ${money5(perPromptCost[c].always_flagship)} | ${money5(perPromptCost[c].always_fast)} | ${money5(perPromptCost[c].tiershift)} | ${(100 * (1 - perPromptCost[c].tiershift / perPromptCost[c].always_flagship)).toFixed(0)}% cheaper |\n`;
const MIXES: { name: string; mix: Record<string, number> }[] = [
  { name: "This benchmark", mix: { ack: 25, simple: 25, moderate: 25, hard: 25 } },
  { name: "Coding agent (illustrative)", mix: { ack: 40, simple: 20, moderate: 30, hard: 10 } },
  { name: "Support assistant (illustrative)", mix: { ack: 30, simple: 50, moderate: 20, hard: 0 } },
  { name: "Research assistant (illustrative)", mix: { ack: 10, simple: 20, moderate: 40, hard: 30 } },
];
md += `\nApplied to four traffic mixes. The three named mixes are illustrative shares, not measured traffic. Quality is the mix-weighted mean of per-category quality from this run.\n\n| Mix (ack / simple / moderate / hard) | Arm | Quality | Cost per 1,000 | Saving vs flagship |\n|---|---|---|---|---|\n`;
for (const { name, mix } of MIXES) {
  const w = (c: string) => mix[c] / 100;
  const cost = (a: string) => 1000 * CATS.reduce((s, c) => s + w(c) * perPromptCost[c][a], 0);
  const qual = (a: string) => CATS.reduce((s, c) => s + w(c) * perPromptQ[c][a], 0);
  const base = cost("always_flagship");
  for (const a of ARMS) md += `| ${a === ARMS[0] ? `${name} (${CATS.map((c) => mix[c]).join(" / ")})` : ""} | ${a} | ${qual(a).toFixed(2)} | $${cost(a).toFixed(2)} | ${a === "always_flagship" ? "baseline" : `${(100 * (1 - cost(a) / base)).toFixed(0)}%`} |\n`;
}

const both = rows.filter((x) => x.quality !== null && x.quality2 !== null);
if (both.length) {
  const exact = both.filter((x) => x.quality === x.quality2).length, within1 = both.filter((x) => Math.abs((x.quality as number) - (x.quality2 as number)) <= 1).length;
  md += `\n## Judge agreement\n\n${both.length} answers scored by both judges. Exact agreement ${((exact / both.length) * 100).toFixed(0)}%, within one point ${((within1 / both.length) * 100).toFixed(0)}%.\n\n| Arm | Mean, ${meta.judge} | Mean, ${meta.judge2 ?? "second judge"} |\n|---|---|---|\n`;
  for (const a of ARMS) { const rs = both.filter((x) => x.arm === a); md += `| ${a} | ${f2(mean(rs.map((x) => x.quality as number)))} | ${f2(mean(rs.map((x) => x.quality2 as number)))} |\n`; }
}

md += `\n## Chart\n\n![Quality against cost, three arms](chart-light.svg)\n\nRebuild with \`npm run bench:chart\`. A dark variant is in \`chart-dark.svg\`.\n\n## Caveats\n\n- The primary judge wrote none of the answers. The second judge shares a family with the fast arm. Judge cost is excluded from every arm.\n- Expected tiers are author labels, used only for the agreement matrix.\n- max_tokens ${meta.max_tokens} caps long answers equally across arms.\n- Prices from \`prices.yaml\` via models.dev on ${meta.date}. DeepSeek is listed at the off-peak rate.\n- Every raw record is in \`results.jsonl\`. Rerun \`npm run bench:report\` to rebuild this file.\n`;

writeFileSync(join(here, "results.md"), md);
console.log(md);
