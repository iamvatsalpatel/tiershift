import { describe, expect, it } from "vitest";
import { buildReport, tune } from "./analytics.js";
import type { LogEntry } from "./log.js";
import type { Config } from "./types.js";

const cfg: Config = {
  providers: { p: { type: "openai-compatible" } },
  tiers: { local: ["p/l"], fast: ["p/f"], mid: ["p/m"], flagship: ["p/x"] },
  rules: [{ when: "trivial_ack > 0.8", tier: "local" }, { when: "difficulty < 0.5", tier: "fast" }, { when: "difficulty < 1.3", tier: "mid" }, { default: "flagship" }],
  overrides: [{ when: "stakes > 1.5", at_least: "flagship" }],
  models: {
    "p/l": { price: { input: 0, output: 0 } }, "p/f": { price: { input: 0.2, output: 1 } },
    "p/m": { price: { input: 2, output: 10 } }, "p/x": { price: { input: 10, output: 50 } },
  },
};
const sig = (difficulty: number, extra: Partial<LogEntry["signals"]> = {}): LogEntry["signals"] => ({
  difficulty, difficulty_confidence: 0.9, needs_reasoning: 0.1, stakes: 0.1, stakes_confidence: 0.9, domain: "general", domain_confidence: 0.9,
  has_code: 0, ambiguous: 0, output_length: 1, creative: 0, safety_sensitive: 0, trivial_ack: 0, mid_tier_ok: 0.5, ...extra,
});
const entry = (tier: string, model: string, difficulty: number, over: Partial<LogEntry> = {}): LogEntry => ({
  ts: "2026-09-17T00:00:00Z", kind: "route", model, tier, requested_tier: tier, degraded: false, fell_back: false, confidence: 0.9,
  signals: sig(difficulty), code_signals: { est_input_tokens: 1000, has_tools: false, tool_count: 0, step: null, retries: 0, turn_count: 1 },
  reason: [], est_cost_usd: 0.001, cost_usd: null, input_tokens: null, output_tokens: null, jev_latency_ms: 200, jev_input_tokens: 900, model_latency_ms: null, ...over,
});

describe("buildReport", () => {
  it("counts tiers, sums cost, and computes saving against the flagship estimate", () => {
    const entries = [entry("fast", "p/f", 0.2, { est_cost_usd: 0.0006 }), entry("fast", "p/f", 0.3, { est_cost_usd: 0.0006 }), entry("flagship", "p/x", 1.9, { est_cost_usd: 0.03, reason: ['override "stakes > 1.5" → at_least flagship'] })];
    const r = buildReport(entries, cfg);
    expect(r.n).toBe(3);
    expect(r.tiers.find((t) => t.tier === "fast")?.n).toBe(2);
    expect(r.tiers.find((t) => t.tier === "flagship")?.share).toBeCloseTo(1 / 3);
    expect(r.total_cost).toBeCloseTo(0.0312);
    // flagship estimate: 1000 in * $10 + 400 out * $50 per 1M = $0.03 per entry, 3 entries
    expect(r.flagship_est_cost).toBeCloseTo(0.09);
    expect(r.saving_vs_flagship).toBeCloseTo(1 - 0.0312 / 0.09);
    expect(r.overrides[0]).toEqual({ reason: 'override "stakes > 1.5"', n: 1 });
    expect(r.jev.p50_ms).toBe(200);
  });
  it("prefers actual cost over the estimate when a model was called", () => {
    const r = buildReport([entry("mid", "p/m", 1.0, { kind: "complete", est_cost_usd: 0.01, cost_usd: 0.02 })], cfg);
    expect(r.total_cost).toBeCloseTo(0.02);
  });
  it("reports estimate vs actual per tier when both exist", () => {
    const r = buildReport([entry("mid", "p/m", 1.0, { kind: "complete", est_cost_usd: 0.01, cost_usd: 0.02 }), entry("mid", "p/m", 1.0, { est_cost_usd: 0.01 })], cfg);
    const mid = r.tiers.find((t) => t.tier === "mid")!;
    expect(mid.estimate_check).toEqual({ n: 1, est: 0.01, actual: 0.02, ratio: 0.5 });
    expect(r.tiers.find((t) => t.tier === "fast")!.estimate_check).toBeUndefined();
  });
  it("handles an empty log", () => {
    const r = buildReport([], cfg);
    expect(r.n).toBe(0); expect(r.saving_vs_flagship).toBeNull();
  });
});

describe("tune", () => {
  it("replays logged signals against a candidate policy and reports moves and saving", () => {
    const entries = [entry("mid", "p/m", 0.9), entry("mid", "p/m", 1.1), entry("flagship", "p/x", 1.5), entry("flagship", "p/x", 1.9)];
    const bolder: Config = { ...cfg, rules: [{ when: "trivial_ack > 0.8", tier: "local" }, { when: "difficulty < 0.5", tier: "fast" }, { when: "difficulty < 1.6", tier: "mid" }, { default: "flagship" }] };
    const t = tune(entries, cfg, bolder);
    expect(t.n).toBe(4);
    expect(t.baseline.tiers).toEqual({ local: 0, fast: 0, mid: 2, flagship: 2 });
    expect(t.candidate.tiers).toEqual({ local: 0, fast: 0, mid: 3, flagship: 1 });
    expect(t.moved_down).toBe(1); expect(t.moved_up).toBe(0); expect(t.unchanged).toBe(3);
    expect(t.moves[0]).toMatchObject({ from: "flagship", to: "mid", difficulty: 1.5 });
    expect(t.saving).toBeGreaterThan(0);
  });
  it("uses the supplied available tiers for the baseline and reports overrides that held a move", () => {
    const e = entry("flagship", "p/x", 1.5, { signals: sig(1.5, { difficulty_confidence: 0.3 }) });
    const withLowConf: Config = { ...cfg, overrides: [{ when: "difficulty_confidence < 0.5", up: 1 }] };
    const bolder: Config = { ...withLowConf, rules: [{ when: "difficulty < 1.6", tier: "mid" }, { default: "flagship" }] };
    const t = tune([e], withLowConf, bolder);
    expect(t.unchanged).toBe(1); expect(t.held_by_override).toBe(1);
    const r = buildReport([e], cfg, { tiers: { ...cfg.tiers, flagship: ["p/m"] } });
    expect(r.flagship_model).toBe("p/m");
  });
  it("respects overrides in the candidate", () => {
    const e = entry("flagship", "p/x", 1.0, { signals: sig(1.0, { stakes: 1.9 }) });
    const t = tune([e], cfg, cfg);
    expect(t.candidate.tiers.flagship).toBe(1); expect(t.unchanged).toBe(1);
  });
});
