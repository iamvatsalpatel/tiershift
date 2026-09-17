/** Aggregations over the decision log for `tiershift report` and `tiershift tune`. Pure functions. */
import { applyPolicy, estimateOutputTokens } from "./policy.js";
import type { LogEntry } from "./log.js";
import type { Config, ModelMeta } from "./types.js";

export interface TierStat { tier: string; n: number; share: number; cost: number; est_cost: number; mean_confidence: number; p50_jev_ms: number }
export interface Report {
  n: number; from: string | null; to: string | null;
  tiers: TierStat[];
  models: { model: string; n: number; cost: number; est_cost: number }[];
  total_cost: number; total_est_cost: number;
  /** What the same requests would have cost on the top model of the top tier, by estimated tokens. */
  flagship_est_cost: number; flagship_model: string | null;
  saving_vs_flagship: number | null;
  jev: { p50_ms: number; p95_ms: number; cost: number };
  degraded: number; fell_back: number; low_confidence: number;
  overrides: { reason: string; n: number }[];
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const JEV_PRICE = 0.042 / 1e6;

export function estCostFor(meta: ModelMeta | undefined, inTok: number, outTok: number): number | null {
  if (!meta?.price) return null;
  return (inTok * meta.price.input + outTok * meta.price.output) / 1e6;
}

/** Cost of one entry: actual when a model was called, else the estimate. */
export function entryCost(e: LogEntry): number { return e.cost_usd ?? e.est_cost_usd ?? 0; }

export interface AnalyticsOptions {
  /** Tier → models actually usable (see `availableTiers`). Defaults to the configured lists. */
  tiers?: Record<string, string[]>;
  /** Model for the always-flagship comparison. Defaults to the first usable model of the top tier. */
  baselineModel?: string;
}

/** First usable model of a tier. */
export function modelForTier(config: Config, tier: string, tiers?: Record<string, string[]>): string | undefined {
  return (tiers ?? config.tiers)[tier]?.[0];
}

export function buildReport(entries: LogEntry[], config: Config, opts: AnalyticsOptions = {}): Report {
  const order = Object.keys(config.tiers);
  const flagshipTier = order[order.length - 1];
  const flagshipModel = opts.baselineModel ?? modelForTier(config, flagshipTier, opts.tiers) ?? null;
  const tiers: TierStat[] = order.map((tier) => {
    const es = entries.filter((e) => e.tier === tier);
    return { tier, n: es.length, share: es.length / (entries.length || 1), cost: sum(es.map(entryCost)), est_cost: sum(es.map((e) => e.est_cost_usd ?? 0)), mean_confidence: es.length ? sum(es.map((e) => e.confidence)) / es.length : 0, p50_jev_ms: pct(es.map((e) => e.jev_latency_ms), 0.5) };
  });
  const modelIds = [...new Set(entries.map((e) => e.model))].sort();
  const models = modelIds.map((model) => { const es = entries.filter((e) => e.model === model); return { model, n: es.length, cost: sum(es.map(entryCost)), est_cost: sum(es.map((e) => e.est_cost_usd ?? 0)) }; });
  const flagshipEst = flagshipModel ? sum(entries.map((e) => estCostFor(config.models?.[flagshipModel], e.code_signals.est_input_tokens, e.output_tokens ?? estimateOutputTokens(e.signals.output_length)) ?? 0)) : 0;
  const total = sum(entries.map(entryCost));
  const overrideCounts = new Map<string, number>();
  for (const e of entries) for (const r of e.reason) if (r.startsWith("override")) overrideCounts.set(r.split(" → ")[0], (overrideCounts.get(r.split(" → ")[0]) ?? 0) + 1);
  return {
    n: entries.length, from: entries[0]?.ts ?? null, to: entries[entries.length - 1]?.ts ?? null,
    tiers, models, total_cost: total, total_est_cost: sum(entries.map((e) => e.est_cost_usd ?? 0)),
    flagship_est_cost: flagshipEst, flagship_model: flagshipModel,
    saving_vs_flagship: flagshipEst > 0 ? 1 - total / flagshipEst : null,
    jev: { p50_ms: pct(entries.map((e) => e.jev_latency_ms), 0.5), p95_ms: pct(entries.map((e) => e.jev_latency_ms), 0.95), cost: sum(entries.map((e) => e.jev_input_tokens * JEV_PRICE)) },
    degraded: entries.filter((e) => e.degraded).length, fell_back: entries.filter((e) => e.fell_back).length,
    low_confidence: entries.filter((e) => e.confidence < 0.5).length,
    overrides: [...overrideCounts.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
  };
}

export interface TuneResult {
  n: number;
  baseline: { tiers: Record<string, number>; est_cost: number };
  candidate: { tiers: Record<string, number>; est_cost: number };
  moved_down: number; moved_up: number; unchanged: number;
  saving: number | null;
  /** Entries where the candidate's rules alone would pick a different tier, but an override held the result. */
  held_by_override: number;
  /** Entries that would move, with the old and new tier, for spot checks. */
  moves: { ts: string; from: string; to: string; difficulty: number; stakes: number; confidence: number }[];
}

/** Replay logged signals against a candidate config. No Jev calls: the signals are already in the log. */
export function tune(entries: LogEntry[], baseline: Config, candidate: Config, opts: AnalyticsOptions = {}): TuneResult {
  const order = Object.keys(candidate.tiers);
  const count = (tiers: string[]) => Object.fromEntries(order.map((t) => [t, tiers.filter((x) => x === t).length]));
  const cost = (cfg: Config, e: LogEntry, tier: string) => {
    const model = modelForTier(cfg, tier, opts.tiers);
    return estCostFor(model ? cfg.models?.[model] : undefined, e.code_signals.est_input_tokens, e.output_tokens ?? estimateOutputTokens(e.signals.output_length)) ?? 0;
  };
  const rulesOnly = (cfg: Config): Config => ({ ...cfg, overrides: [] });
  const base: string[] = [], cand: string[] = [], moves: TuneResult["moves"] = [];
  let bCost = 0, cCost = 0, down = 0, up = 0, held = 0;
  for (const e of entries) {
    const b = applyPolicy(baseline, e.signals, e.code_signals).tier;
    const c = applyPolicy(candidate, e.signals, e.code_signals).tier;
    base.push(b); cand.push(c); bCost += cost(baseline, e, b); cCost += cost(candidate, e, c);
    if (b !== c) { if (order.indexOf(c) < order.indexOf(b)) down++; else up++; moves.push({ ts: e.ts, from: b, to: c, difficulty: e.signals.difficulty, stakes: e.signals.stakes, confidence: e.confidence }); }
    else if (applyPolicy(rulesOnly(baseline), e.signals, e.code_signals).tier !== applyPolicy(rulesOnly(candidate), e.signals, e.code_signals).tier) held++;
  }
  return { n: entries.length, baseline: { tiers: count(base), est_cost: bCost }, candidate: { tiers: count(cand), est_cost: cCost }, moved_down: down, moved_up: up, unchanged: entries.length - down - up, saving: bCost > 0 ? 1 - cCost / bCost : null, held_by_override: held, moves };
}
