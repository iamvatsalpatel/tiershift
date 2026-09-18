import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromDecision, logEntry, readLog } from "./log.js";
import type { Decision } from "./types.js";

const decision: Decision = {
  model: "p/m", provider: "p", tier: "mid", tier_index: 2, requested_tier: "mid", degraded: false, fallback: "p/x", fallback_tier: "flagship",
  signals: { difficulty: 1, difficulty_confidence: 0.8, needs_reasoning: 0.5, stakes: 0.2, stakes_confidence: 0.9, domain: "code", domain_confidence: 0.9, has_code: 0.9, ambiguous: 0.1, output_length: 1, creative: 0, safety_sensitive: 0, trivial_ack: 0, mid_tier_ok: 0.5 },
  code_signals: { est_input_tokens: 120, has_tools: false, tool_count: 0, step: null, retries: 0, turn_count: 1 },
  confidence: 0.8, reason: ['rule "difficulty < 1.3" → mid'], est_cost_usd: 0.004, est_flagship_cost_usd: 0.04, est_flagship_model: "p/x", est_output_tokens: 400, jev_latency_ms: 210, jev_input_tokens: 950,
};

describe("decision log", () => {
  it("appends and reads back entries, creating the directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "tiershift-"));
    const path = join(dir, "nested", "decisions.jsonl");
    logEntry(path, fromDecision(decision, { kind: "route", tag: "agent-a" }));
    logEntry(path, fromDecision(decision, { kind: "complete", cost_usd: 0.0031, input_tokens: 100, output_tokens: 50, model_latency_ms: 900 }));
    const rows = readLog(path);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "route", tier: "mid", model: "p/m", tag: "agent-a", cost_usd: null, est_cost_usd: 0.004 });
    expect(rows[1]).toMatchObject({ kind: "complete", cost_usd: 0.0031, output_tokens: 50 });
    expect(JSON.stringify(rows[0])).not.toContain("prompt");
  });
  it("returns an empty list for a missing file", () => {
    expect(readLog(join(tmpdir(), "does-not-exist-" + Date.now(), "x.jsonl"))).toEqual([]);
  });
});
