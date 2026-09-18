import { describe, expect, it } from "vitest";
import { mean, pct, summary } from "./lib.js";
import type { Record_ } from "./run.js";

const rec = (over: Partial<Record_>): Record_ => ({
  id: "x", category: "ack", expected_tier: "local", arm: "tiershift", model: "m", served_model: "m", tier: "local", fell_back: false,
  quality: 5, judge_note: "", quality2: 5, judge2_note: "", input_tokens: 10, output_tokens: 5, cost_usd: 0.001, latency_ms: 100, jev_latency_ms: 300, jev_cost_usd: 0.00004,
  signals: null, reason: null, answer_chars: 10, empty_answer: false, error: null, ...over,
});

describe("bench aggregation", () => {
  it("mean and percentile handle empty and small inputs", () => {
    expect(mean([])).toBeNaN(); expect(mean([2, 4])).toBe(3);
    expect(pct([5, 1, 3], 0.5)).toBe(3); expect(pct([5, 1, 3], 0.95)).toBe(5);
  });
  it("summary excludes errored and unjudged records from quality and cost, but counts them", () => {
    const s = summary([rec({ quality: 5, cost_usd: 0.01 }), rec({ quality: 3, cost_usd: 0.02 }), rec({ quality: null, cost_usd: 0.5, error: "boom", empty_answer: true })]);
    expect(s.n).toBe(2); expect(s.total).toBe(3); expect(s.errors).toBe(1); expect(s.empty).toBe(1);
    expect(s.quality).toBe(4); expect(s.cost).toBeCloseTo(0.03); expect(s.per1k).toBeCloseTo(15); expect(s.q5).toBe(0.5);
  });
});
