/**
 * Experiment: can Jev tell, from the ANSWER, when the fast model fell short? And does a jev-router style
 * single Choice with what/not_for criteria route better than our eleven signals?
 * Jev only. No provider calls. Uses the cached fast-tier answers from the benchmark.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, "..", "..", ".env"), "utf8").split("\n")) { const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
const client = new TypeSafeClient({ defaultModel: "jev-1.13.0" });
const key = (parts: unknown) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
const cachedText = (model: string, id: string) => JSON.parse(readFileSync(join(here, "..", "cache", key(["fixed", model, id, 4096]) + ".json"), "utf8")).text as string;
const cache = (k: string, fn: () => Promise<unknown>) => { const p = join(here, "..", "cache", "exp-" + k + ".json"); if (existsSync(p)) return Promise.resolve(JSON.parse(readFileSync(p, "utf8"))); return fn().then((v) => { writeFileSync(p, JSON.stringify(v)); return v; }); };

const rows = readFileSync(join(here, "..", "results.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const prompts = readFileSync(join(here, "..", "prompts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) as { id: string; prompt: string }[];
const q = (arm: string, id: string, k = "quality") => rows.find((r) => r.arm === arm && r.id === id)![k] as number;
const FAST = "deepseek/deepseek-flash";

const GATE = {
  addresses: noul({ question: "Does `answer` fully and correctly address `request`?", yes_means: "Every part of the request is answered correctly, nothing is invented, and there is no filler.", no_means: "A part is missing or wrong, the answer invents context the request did not give, or it pads a trivial request with unnecessary text." }),
  invents_context: noul("Does `answer` refer to files, prior messages, tasks, or facts that `request` never mentioned?"),
  padded: noul("Is `answer` noticeably longer or more elaborate than `request` warrants?"),
  quality: score("How good is `answer` as a reply to `request`?", ["poor: wrong, empty, off-topic, or invents context", "acceptable: right in substance but with a gap, an error, or padding", "excellent: correct, complete, and no longer than needed"]),
};
const TIER = {
  tier: choice({ question: "Pick the cheapest model tier that can fully answer `request` in one pass, with no retry on a stronger model." }, {
    fast: { what: "Trivial, mechanical, factual, or conversational work. Short rewrites, lookups, acknowledgements, small code snippets.", not_for: "Anything needing design judgement, proofs, multi-step debugging, or expert domain knowledge." },
    mid: { what: "Ordinary skilled work with a clear, bounded shape: explanations, moderate code, structured analysis, standard proofs.", not_for: "Open-ended architecture, subtle trade-off analysis, legal or financial exposure, or work where an error is costly." },
    flagship: { what: "Hard reasoning under ambiguity, expert-level trade-offs, or high blast radius: production systems, contracts, money, safety.", not_for: "Anything a competent senior engineer would finish without deep thought." },
  }),
};

let tokens = 0;
const gates: Record<string, any> = {}, tiers: Record<string, any> = {};
let i = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (i < prompts.length) {
    const p = prompts[i++];
    const answer = cachedText(FAST, p.id);
    const g = await cache(key(["gate-v1", p.id, answer]), async () => { const r = await client.systemOne({ state: { request: p.prompt, answer }, questions: GATE }); tokens += r.usage.input_tokens; return r.answers; });
    const t = await cache(key(["tier-v1", p.id]), async () => { const r = await client.systemOne({ state: { request: p.prompt }, questions: TIER }); tokens += r.usage.input_tokens; return r.answers; });
    gates[p.id] = g; tiers[p.id] = t;
  }
}));

const ids = prompts.map((p) => p.id);
const fell = ids.filter((id) => q("always_fast", id) < q("always_flagship", id));
const fine = ids.filter((id) => !fell.includes(id));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

console.log(`\n=== GATE: judge the fast answer with Jev (${ids.length} answers, ${fell.length} where fast < flagship per Sonnet) ===`);
for (const k of ["addresses", "invents_context", "padded"]) console.log(`  ${k.padEnd(16)} mean on fell-short ${mean(fell.map((id) => gates[id][k].noul)).toFixed(2)}   on fine ${mean(fine.map((id) => gates[id][k].noul)).toFixed(2)}`);
console.log(`  quality score    mean on fell-short ${mean(fell.map((id) => gates[id].quality.score)).toFixed(2)}   on fine ${mean(fine.map((id) => gates[id].quality.score)).toFixed(2)}`);
for (const th of [0.5, 0.6, 0.7, 0.8]) {
  const flagged = ids.filter((id) => gates[id].addresses.noul < th);
  const tp = flagged.filter((id) => fell.includes(id)).length;
  console.log(`  addresses < ${th}: flags ${flagged.length}/120, catches ${tp}/${fell.length} of the fell-short, false alarms ${flagged.length - tp}`);
}
// Retry policy: fast first; if addresses < th, retry on mid. Score exactly from cached answers. Cost = fast + mid (+jev gate ~$0.0001).
const flC = ids.reduce((s, id) => s + rows.find((r) => r.arm === "always_flagship" && r.id === id)!.cost_usd, 0);
const flQ = mean(ids.map((id) => q("always_flagship", id)));
for (const th of [0.5, 0.7]) {
  let c = 0, qq = 0, retried = 0;
  for (const id of ids) {
    const fr = rows.find((r) => r.arm === "always_fast" && r.id === id)!; c += fr.cost_usd + 0.0001;
    if (gates[id].addresses.noul < th) { retried++; const mr = rows.find((r) => r.arm === "always_mid" && r.id === id)!; c += mr.cost_usd; qq += mr.quality; } else qq += fr.quality;
  }
  console.log(`  POLICY fast → gate(${th}) → mid: quality ${(qq / 120).toFixed(2)} (${(100 * qq / 120 / flQ).toFixed(1)}% of flagship)  $${(c / 120 * 1000).toFixed(2)}/1k  saves ${(100 * (1 - c / flC)).toFixed(0)}%  retried ${retried}`);
}

console.log(`\n=== TIER: one jev-router style Choice with what/not_for ===`);
const dist = { fast: 0, mid: 0, flagship: 0 } as Record<string, number>;
let c2 = 0, q2 = 0;
for (const id of ids) { const t = tiers[id].tier.choice as string; dist[t]++; const arm = { fast: "always_fast", mid: "always_mid", flagship: "always_flagship" }[t]!; c2 += rows.find((r) => r.arm === arm && r.id === id)!.cost_usd + 0.00004; q2 += q(arm, id); }
console.log(`  routes: ${JSON.stringify(dist)}  quality ${(q2 / 120).toFixed(2)} (${(100 * q2 / 120 / flQ).toFixed(1)}%)  $${(c2 / 120 * 1000).toFixed(2)}/1k  saves ${(100 * (1 - c2 / flC)).toFixed(0)}%`);
console.log(`  mean confidence ${mean(ids.map((id) => tiers[id].tier.confidence)).toFixed(2)}; sent to fast where fast fell short: ${fell.filter((id) => tiers[id].tier.choice === "fast").length}/${fell.length}`);
console.log(`\njev tokens this run: ${tokens} ($${(tokens * 0.042 / 1e6).toFixed(4)})`);
