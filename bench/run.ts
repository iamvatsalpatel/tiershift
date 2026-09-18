/**
 * tiershift benchmark runner.
 * Four arms over the same prompts: always_flagship, always_mid, always_fast, tiershift.
 * One answer per (model, prompt), cached by content hash and shared across arms, so tiershift is judged on
 * the exact same answer the fixed arm got from that model. Two blind judges from families that wrote no answers.
 * Reruns replay from bench/cache/ and cost nothing.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRouter, loadConfig, splitModel } from "../src/index.js";
import type { Config, Decision, Message } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const CACHE = join(here, "cache");
const OUT = join(here, "results.jsonl");
const MAX_TOKENS = 4096;
const CONCURRENCY = 6;
const JUDGE_VERSION = "judge-v3";

try {
  for (const line of readFileSync(join(here, "..", ".env"), "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* no .env is fine */ }

/** Models under test. Pinned: a new provider key must never change the arms or invalidate the cache. */
const FLAGSHIP = process.env.BENCH_FLAGSHIP ?? "openai/gpt-5.6-sol";
const MID = process.env.BENCH_MID ?? "openai/gpt-5.6-terra";
const FAST = process.env.BENCH_FAST ?? "deepseek/deepseek-flash";
const LOCAL = process.env.BENCH_LOCAL ?? "ollama/qwen2.5:7b";
/** Judges. Sonnet 5 wrote no answers. DeepSeek v4-pro shares a family with the fast arm; it is the second opinion. */
const JUDGE = process.env.BENCH_JUDGE ?? "anthropic/claude-sonnet-5";
const JUDGE2 = process.env.BENCH_JUDGE2 ?? "deepseek/deepseek-v4-pro";
const JEV_PRICE_PER_TOKEN = 0.042 / 1e6;

type Arm = "always_flagship" | "always_mid" | "always_fast" | "tiershift";
const ARMS: Arm[] = ["always_flagship", "always_mid", "always_fast", "tiershift"];
const FIXED: Record<Exclude<Arm, "tiershift">, string> = { always_flagship: FLAGSHIP, always_mid: MID, always_fast: FAST };

interface Prompt { id: string; category: string; expected_tier: string; prompt: string }
export interface Record_ {
  id: string; category: string; expected_tier: string; arm: Arm;
  model: string; served_model: string; tier: string | null; fell_back: boolean;
  quality: number | null; judge_note: string | null;
  quality2: number | null; judge2_note: string | null;
  input_tokens: number; output_tokens: number; cost_usd: number | null;
  latency_ms: number; jev_latency_ms: number; jev_cost_usd: number;
  signals: Decision["signals"] | null; reason: string[] | null;
  answer_chars: number; empty_answer: boolean; error: string | null;
}

// The routed arm chooses among exactly the models the fixed arms use. Same policy as the shipped default.
const base = loadConfig();
const benchConfig: Config = { ...base, tiers: { local: [LOCAL], fast: [FAST], mid: [MID], flagship: [FLAGSHIP] }, log: { enabled: false } };
const router = createRouter({ config: benchConfig });
for (const id of [FLAGSHIP, MID, FAST, LOCAL, JUDGE, JUDGE2]) {
  const { provider } = splitModel(id);
  if (!router.providers[provider]) throw new Error(`No key for provider "${provider}" (needed by ${id}). Set it in .env or override BENCH_* env vars.`);
}

function cacheKey(parts: unknown): string { return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24); }
function cached<T>(key: string, fn: () => Promise<T>, valid: (v: T) => boolean = () => true): Promise<T> {
  const p = join(CACHE, key + ".json");
  if (existsSync(p)) return Promise.resolve(JSON.parse(readFileSync(p, "utf8")) as T);
  return fn().then((v) => { if (valid(v)) writeFileSync(p, JSON.stringify(v)); return v; });
}

interface Answer { text: string; served: string; in: number; out: number; cost: number | null; ms: number; finish?: string }
function priceOf(modelId: string, inTok: number, outTok: number): number | null {
  const meta = router.config.models?.[modelId];
  return meta?.price ? (inTok * meta.price.input + outTok * meta.price.output) / 1e6 : null;
}
async function callModel(modelId: string, messages: Message[], maxTokens: number, params?: Record<string, unknown>) {
  const { provider, model } = splitModel(modelId);
  const p = router.providers[provider];
  if (!p) throw new Error(`no provider for ${modelId}`);
  return p.complete({ model, messages, maxTokens, params: { ...(router.config.models?.[modelId]?.params ?? {}), ...(params ?? {}) } });
}
/** One answer per (model, prompt). The same cache key as earlier runs, so paid answers are never regenerated. */
function answerFor(modelId: string, pr: Prompt): Promise<Answer> {
  return cached(cacheKey(["fixed", modelId, pr.id, MAX_TOKENS]), async () => {
    const r = await callModel(modelId, [{ role: "user", content: pr.prompt }], MAX_TOKENS);
    return { text: r.text, served: r.servedModel, in: r.usage.inputTokens, out: r.usage.outputTokens, cost: priceOf(modelId, r.usage.inputTokens, r.usage.outputTokens), ms: r.latencyMs, finish: r.finishReason };
  });
}
/** Same rule the shipped router applies: an empty answer that hit the output cap is a failure. */
const isEmptyLength = (a: Answer) => a.text.trim().length === 0 && (a.finish === "length" || a.out >= MAX_TOKENS);

const JUDGE_SYSTEM = `You grade answers to prompts. You see a prompt and one answer. You do not know which model wrote it.
Score the answer from 1 to 5:
5 = correct, complete for the prompt's scope, clear, no errors.
4 = correct with minor gaps or small stylistic issues.
3 = mostly right but missing something important, or partly unclear.
2 = significant errors or omissions; a careful reader would not rely on it.
1 = wrong, empty, off-topic, or refuses without reason.
For trivial prompts (acknowledgements, one-word answers) a short correct reply is a 5. Length is not quality.
Respond with exactly one line of JSON: {"score": <1-5>, "note": "<under 20 words>"}`;

/** Judges run with thinking off: one JSON line, cheap, and the same on rerun. OpenAI judges take reasoning_effort instead. */
function judgeParams(judgeId: string): Record<string, unknown> {
  const { provider } = splitModel(judgeId);
  const url = router.config.providers[provider]?.base_url ?? "";
  if (/api\.openai\.com/.test(url)) return { reasoning_effort: "low" };
  return { thinking: { type: "disabled" } };
}
interface Judgment { score: number | null; note: string | null; cost: number }
function judgeFor(judgeId: string, pr: Prompt, text: string): Promise<Judgment> {
  const params = judgeParams(judgeId);
  return cached(cacheKey([JUDGE_VERSION, judgeId, params, pr.id, text]), async () => {
    const r = await callModel(judgeId, [{ role: "system", content: JUDGE_SYSTEM }, { role: "user", content: `PROMPT:\n${pr.prompt}\n\nANSWER:\n${text || "(empty)"}` }], 600, params);
    const m = /\{[\s\S]*?\}/.exec(r.text);
    let score: number | null = null, note: string | null = null;
    if (m) { try { const j = JSON.parse(m[0]); score = Number(j.score); note = String(j.note ?? ""); } catch { /* unparsed */ } }
    if (score === null || Number.isNaN(score) || score < 1 || score > 5) { score = null; note = `unparsed: ${r.text.slice(0, 80)}`; }
    return { score, note, cost: priceOf(judgeId, r.usage.inputTokens, r.usage.outputTokens) ?? 0 };
  }, (v) => v.score !== null);
}

let judgeCost = 0;

async function runOne(pr: Prompt, arm: Arm): Promise<Record_> {
  const messages: Message[] = [{ role: "user", content: pr.prompt }];
  const basePart = { id: pr.id, category: pr.category, expected_tier: pr.expected_tier, arm };
  try {
    let model: string, tier: string | null = null, fell = false, a: Answer, extraCost = 0, extraMs = 0, jevMs = 0, jevCost = 0;
    let signals: Decision["signals"] | null = null, reason: string[] | null = null;
    if (arm === "tiershift") {
      const d = await cached(cacheKey(["route", pr.id, benchConfig.tiers, benchConfig.rules, benchConfig.overrides, benchConfig.jev?.model]), () => router.route({ messages }));
      jevMs = d.jev_latency_ms; jevCost = d.jev_input_tokens * JEV_PRICE_PER_TOKEN; signals = d.signals; reason = d.reason;
      model = d.model; tier = d.tier;
      a = await answerFor(model, pr);
      if (isEmptyLength(a) && d.fallback) {
        extraCost += a.cost ?? 0; extraMs += a.ms; // the failed attempt is still billed and still takes time
        model = d.fallback; tier = d.fallback_tier; fell = true;
        a = await answerFor(model, pr);
      }
    } else {
      model = FIXED[arm];
      a = await answerFor(model, pr);
    }
    const [j, j2] = await Promise.all([judgeFor(JUDGE, pr, a.text), judgeFor(JUDGE2, pr, a.text)]);
    judgeCost += j.cost + j2.cost;
    return { ...basePart, model, served_model: a.served, tier, fell_back: fell, quality: j.score, judge_note: j.note, quality2: j2.score, judge2_note: j2.note,
      input_tokens: a.in, output_tokens: a.out, cost_usd: a.cost === null ? null : a.cost + extraCost + jevCost, latency_ms: a.ms + extraMs + jevMs,
      jev_latency_ms: jevMs, jev_cost_usd: jevCost, signals, reason, answer_chars: a.text.length, empty_answer: a.text.trim().length === 0, error: null };
  } catch (e) {
    return { ...basePart, model: "", served_model: "", tier: null, fell_back: false, quality: null, judge_note: null, quality2: null, judge2_note: null, input_tokens: 0, output_tokens: 0, cost_usd: null,
      latency_ms: 0, jev_latency_ms: 0, jev_cost_usd: 0, signals: null, reason: null, answer_chars: 0, empty_answer: true, error: e instanceof Error ? e.message : String(e) };
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

async function warmLocal() {
  const { provider, model } = splitModel(LOCAL);
  const p = router.providers[provider];
  if (!p) return;
  const t0 = performance.now();
  try { await p.complete({ model, messages: [{ role: "user", content: "hi" }], maxTokens: 1 }); console.log(`warmed ${LOCAL} in ${Math.round(performance.now() - t0)} ms`); }
  catch (e) { console.log(`warm-up failed for ${LOCAL}: ${e instanceof Error ? e.message : e}`); }
}

async function main() {
  mkdirSync(CACHE, { recursive: true });
  const prompts: Prompt[] = readFileSync(join(here, "prompts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const only = process.argv.includes("--smoke") ? prompts.filter((_, i) => i % 15 === 0) : prompts;
  console.log(`arms: flagship=${FLAGSHIP} mid=${MID} fast=${FAST} local=${LOCAL} | judges: ${JUDGE}, ${JUDGE2} | prompts=${only.length} max_tokens=${MAX_TOKENS}`);
  await warmLocal();
  const jobs = only.flatMap((p) => ARMS.map((arm) => ({ p, arm })));
  let done = 0; const t0 = performance.now();
  const records = await pool(jobs, CONCURRENCY, async ({ p, arm }) => {
    const r = await runOne(p, arm); done++;
    if (done % 16 === 0 || done === jobs.length) process.stdout.write(`\r${done}/${jobs.length}  ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    return r;
  });
  process.stdout.write("\n");
  writeFileSync(OUT, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const errs = records.filter((r) => r.error);
  const spend = records.filter((r) => r.arm !== "tiershift").reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  console.log(`wrote ${records.length} records. errors: ${errs.length}. judge cost this run (incl. cached): $${judgeCost.toFixed(4)}. answer cost across fixed arms (incl. cached): $${spend.toFixed(4)}`);
  for (const e of errs.slice(0, 5)) console.log(`  ! ${e.arm} ${e.id}: ${e.error}`);
  writeFileSync(join(here, "meta.json"), JSON.stringify({ flagship: FLAGSHIP, mid: MID, fast: FAST, local: LOCAL, judge: JUDGE, judge2: JUDGE2, max_tokens: MAX_TOKENS, date: new Date().toISOString().slice(0, 10), prompts: only.length, rules: benchConfig.rules, overrides: benchConfig.overrides }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
