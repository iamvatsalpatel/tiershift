/**
 * tiershift benchmark runner.
 * Runs every prompt through three arms, judges each answer blind, and writes results.jsonl.
 * Responses and judgments are cached in bench/cache/ so a rerun costs nothing.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRouter, splitModel } from "../src/index.js";
import type { Decision, Message } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const CACHE = join(here, "cache");
const OUT = join(here, "results.jsonl");
const MAX_TOKENS = 4096;
const CONCURRENCY = 6;
const JUDGE_VERSION = "judge-v2";

// Load .env without a dependency.
try {
  for (const line of readFileSync(join(here, "..", ".env"), "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* fine */ }

interface Prompt { id: string; category: string; expected_tier: string; prompt: string }
export interface Record_ {
  id: string; category: string; expected_tier: string; arm: string;
  model: string; served_model: string; tier: string | null; fell_back: boolean;
  quality: number | null; judge_note: string | null;
  input_tokens: number; output_tokens: number; cost_usd: number | null;
  latency_ms: number; jev_latency_ms: number; jev_cost_usd: number;
  signals: Decision["signals"] | null; reason: string[] | null;
  answer_chars: number; empty_answer: boolean; error: string | null;
}

const router = createRouter();
const order = Object.keys(router.config.tiers);
const av = router.available();
const firstAvailable = (tier: string) => av[tier]?.[0];
const FLAGSHIP = firstAvailable(order[order.length - 1]);
const FAST = firstAvailable("fast") ?? firstAvailable(order[1]);
if (!FLAGSHIP || !FAST) throw new Error(`Need keys for a flagship and a fast model. Available: ${JSON.stringify(av)}`);
const JUDGE = FLAGSHIP;
const JEV_PRICE_PER_TOKEN = 0.042 / 1e6;

function cacheKey(parts: unknown): string { return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24); }
function cached<T>(key: string, fn: () => Promise<T>, valid: (v: T) => boolean = () => true): Promise<T> {
  const p = join(CACHE, key + ".json");
  if (existsSync(p)) return Promise.resolve(JSON.parse(readFileSync(p, "utf8")) as T);
  return fn().then((v) => { if (valid(v)) writeFileSync(p, JSON.stringify(v)); return v; });
}

/** OpenAI reasoning models take `reasoning_effort`; other providers reject it. */
function judgeParams(): Record<string, unknown> {
  const { provider } = splitModel(JUDGE);
  const base = router.config.models?.[JUDGE]?.params ?? {};
  const isOpenAI = /api\.openai\.com/.test(router.config.providers[provider]?.base_url ?? "");
  return isOpenAI ? { ...base, reasoning_effort: "low" } : base;
}

/** Load local models into memory so the first benchmark call does not pay the cold start. */
async function warmLocal() {
  for (const [name, p] of Object.entries(router.config.providers)) {
    if (p.api_key_env || !/localhost|127\.0\.0\.1/.test(p.base_url ?? "")) continue;
    for (const id of Object.values(router.config.tiers).flat().filter((m) => splitModel(m).provider === name)) {
      const t0 = performance.now();
      try { await router.providers[name]!.complete({ model: splitModel(id).model, messages: [{ role: "user", content: "hi" }], maxTokens: 1 }); console.log(`warmed ${id} in ${Math.round(performance.now() - t0)} ms`); }
      catch (e) { console.log(`warm-up failed for ${id}: ${e instanceof Error ? e.message : e}`); }
    }
  }
}

async function callFixed(modelId: string, messages: Message[]) {
  const { provider, model } = splitModel(modelId);
  const p = router.providers[provider];
  if (!p) throw new Error(`no provider for ${modelId}`);
  const r = await p.complete({ model, messages, maxTokens: MAX_TOKENS, params: router.config.models?.[modelId]?.params });
  const meta = router.config.models?.[modelId];
  const cost = meta?.price ? (r.usage.inputTokens * meta.price.input + r.usage.outputTokens * meta.price.output) / 1e6 : null;
  return { text: r.text, served: r.servedModel, in: r.usage.inputTokens, out: r.usage.outputTokens, cost, ms: r.latencyMs };
}

const JUDGE_SYSTEM = `You grade answers to prompts. You see a prompt and one answer. You do not know which model wrote it.
Score the answer from 1 to 5:
5 = correct, complete for the prompt's scope, clear, no errors.
4 = correct with minor gaps or small stylistic issues.
3 = mostly right but missing something important, or partly unclear.
2 = significant errors or omissions; a careful reader would not rely on it.
1 = wrong, empty, off-topic, or refuses without reason.
For trivial prompts (acknowledgements, one-word answers) a short correct reply is a 5. Length is not quality.
Respond with exactly one line of JSON: {"score": <1-5>, "note": "<under 20 words>"}`;

async function judge(prompt: string, answer: string) {
  const { provider, model } = splitModel(JUDGE);
  const p = router.providers[provider]!;
  const r = await p.complete({
    model,
    messages: [{ role: "system", content: JUDGE_SYSTEM }, { role: "user", content: `PROMPT:\n${prompt}\n\nANSWER:\n${answer || "(empty)"}` }],
    maxTokens: 600,
    params: judgeParams(),
  });
  const m = /\{[\s\S]*\}/.exec(r.text);
  let score: number | null = null, note: string | null = null;
  if (m) { try { const j = JSON.parse(m[0]); score = Number(j.score); note = String(j.note ?? ""); } catch { /* fall through */ } }
  if (score === null || Number.isNaN(score)) { score = null; note = `unparsed: ${r.text.slice(0, 80)}`; }
  const meta = router.config.models?.[JUDGE];
  const cost = meta?.price ? (r.usage.inputTokens * meta.price.input + r.usage.outputTokens * meta.price.output) / 1e6 : 0;
  return { score, note, cost };
}

let judgeCost = 0;

async function runOne(pr: Prompt, arm: "always_flagship" | "always_fast" | "tiershift"): Promise<Record_> {
  const messages: Message[] = [{ role: "user", content: pr.prompt }];
  const base = { id: pr.id, category: pr.category, expected_tier: pr.expected_tier, arm };
  try {
    let text = "", model = "", served = "", tier: string | null = null, fell = false, inT = 0, outT = 0, cost: number | null = null, ms = 0, jevMs = 0, jevCost = 0;
    let signals: Decision["signals"] | null = null, reason: string[] | null = null;
    if (arm === "tiershift") {
      const r = await cached(cacheKey(["route+complete", pr.id, MAX_TOKENS, router.config.tiers, router.config.rules, router.config.overrides]), async () => {
        const c = await router.complete({ messages, maxTokens: MAX_TOKENS });
        const { raw, ...rest } = c; return rest;
      });
      text = r.text; model = r.model; served = r.served_model; tier = r.decision.tier; fell = r.fell_back;
      inT = r.usage.input_tokens; outT = r.usage.output_tokens; cost = r.cost_usd; ms = r.latency_ms + r.decision.jev_latency_ms;
      jevMs = r.decision.jev_latency_ms; jevCost = r.decision.jev_input_tokens * JEV_PRICE_PER_TOKEN; signals = r.decision.signals; reason = r.decision.reason;
    } else {
      model = arm === "always_flagship" ? FLAGSHIP : FAST;
      const r = await cached(cacheKey(["fixed", model, pr.id, MAX_TOKENS]), () => callFixed(model, messages));
      text = r.text; served = r.served; inT = r.in; outT = r.out; cost = r.cost; ms = r.ms;
    }
    const j = await cached(cacheKey([JUDGE_VERSION, JUDGE, judgeParams(), pr.id, text]), () => judge(pr.prompt, text), (v) => v.score !== null);
    judgeCost += j.cost;
    return { ...base, model, served_model: served, tier, fell_back: fell, quality: j.score, judge_note: j.note, input_tokens: inT, output_tokens: outT,
      cost_usd: cost === null ? null : cost + jevCost, latency_ms: ms, jev_latency_ms: jevMs, jev_cost_usd: jevCost, signals, reason, answer_chars: text.length, empty_answer: text.trim().length === 0, error: null };
  } catch (e) {
    return { ...base, model: "", served_model: "", tier: null, fell_back: false, quality: null, judge_note: null, input_tokens: 0, output_tokens: 0, cost_usd: null,
      latency_ms: 0, jev_latency_ms: 0, jev_cost_usd: 0, signals: null, reason: null, answer_chars: 0, empty_answer: true, error: e instanceof Error ? e.message : String(e) };
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

async function main() {
  mkdirSync(CACHE, { recursive: true });
  const prompts: Prompt[] = readFileSync(join(here, "prompts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const only = process.argv.includes("--smoke") ? prompts.filter((_, i) => i % 15 === 0) : prompts;
  console.log(`arms: always_flagship=${FLAGSHIP}  always_fast=${FAST}  tiershift=policy   judge=${JUDGE}   prompts=${only.length}   max_tokens=${MAX_TOKENS}`);
  await warmLocal();
  const jobs = only.flatMap((p) => (["always_flagship", "always_fast", "tiershift"] as const).map((arm) => ({ p, arm })));
  let done = 0;
  const t0 = performance.now();
  const records = await pool(jobs, CONCURRENCY, async ({ p, arm }) => {
    const r = await runOne(p, arm); done++;
    if (done % 12 === 0 || done === jobs.length) process.stdout.write(`\r${done}/${jobs.length}  ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    return r;
  });
  process.stdout.write("\n");
  writeFileSync(OUT, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const errs = records.filter((r) => r.error);
  console.log(`wrote ${records.length} records to ${OUT}. errors: ${errs.length}. judge cost this run: $${judgeCost.toFixed(4)}`);
  for (const e of errs.slice(0, 5)) console.log(`  ! ${e.arm} ${e.id}: ${e.error}`);
  writeFileSync(join(here, "meta.json"), JSON.stringify({ flagship: FLAGSHIP, fast: FAST, judge: JUDGE, max_tokens: MAX_TOKENS, date: new Date().toISOString().slice(0, 10), prompts: only.length }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
