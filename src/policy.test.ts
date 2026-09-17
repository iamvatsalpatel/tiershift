import { describe, expect, it } from "vitest";
import { applyPolicy, estimateOutputTokens, evalCondition } from "./policy.js";
import type { CodeSignals, Config, Signals } from "./types.js";

const base: Signals = {
  difficulty: 0, difficulty_confidence: 1, needs_reasoning: 0, stakes: 0, stakes_confidence: 1,
  domain: "general", domain_confidence: 1, has_code: 0, ambiguous: 0, output_length: 0,
  creative: 0, safety_sensitive: 0, trivial_ack: 0, mid_tier_ok: 0.5,
};
const code: CodeSignals = { est_input_tokens: 100, has_tools: false, tool_count: 0, step: null, retries: 0, turn_count: 1 };

const cfg: Config = {
  providers: { x: { type: "openai-compatible" } },
  tiers: { local: ["x/a"], fast: ["x/b"], mid: ["x/c"], flagship: ["x/d"] },
  rules: [
    { when: "trivial_ack > 0.8", tier: "local" },
    { when: "difficulty < 0.5", tier: "fast" },
    { when: "difficulty < 1.3", tier: "mid" },
    { default: "flagship" },
  ],
  overrides: [
    { when: "stakes > 1.5", at_least: "flagship" },
    { when: "needs_reasoning > 0.8", at_least: "mid" },
    { when: "has_tools and tier == local", at_least: "fast" },
    { when: "difficulty_confidence < 0.5", up: 1 },
    { when: "retries >= 1", up: 1 },
  ],
};

describe("evalCondition", () => {
  const vars = { difficulty: 0.7, tier: "local", has_tools: true, retries: 0 };
  it("compares numbers", () => {
    expect(evalCondition("difficulty < 1.3", vars)).toBe(true);
    expect(evalCondition("difficulty >= 0.7", vars)).toBe(true);
    expect(evalCondition("difficulty > 0.7", vars)).toBe(false);
  });
  it("compares strings and booleans", () => {
    expect(evalCondition("tier == local", vars)).toBe(true);
    expect(evalCondition("has_tools", vars)).toBe(true);
    expect(evalCondition("has_tools and tier == local", vars)).toBe(true);
    expect(evalCondition("retries >= 1 or tier == local", vars)).toBe(true);
  });
  it("rejects unknown variables", () => {
    expect(() => evalCondition("nope > 1", vars)).toThrow(/unknown signal "nope"/);
  });
});

describe("applyPolicy", () => {
  it("routes trivial acks to local", () => {
    expect(applyPolicy(cfg, { ...base, trivial_ack: 0.95 }, code).tier).toBe("local");
  });
  it("routes by difficulty bands", () => {
    expect(applyPolicy(cfg, { ...base, difficulty: 0.2 }, code).tier).toBe("fast");
    expect(applyPolicy(cfg, { ...base, difficulty: 0.9 }, code).tier).toBe("mid");
    expect(applyPolicy(cfg, { ...base, difficulty: 1.8 }, code).tier).toBe("flagship");
  });
  it("high stakes forces flagship even when easy", () => {
    const r = applyPolicy(cfg, { ...base, difficulty: 0.1, stakes: 1.9 }, code);
    expect(r.tier).toBe("flagship");
    expect(r.reason.join(" ")).toMatch(/at_least flagship/);
  });
  it("reasoning raises a fast prompt to mid", () => {
    expect(applyPolicy(cfg, { ...base, difficulty: 0.3, needs_reasoning: 0.95 }, code).tier).toBe("mid");
  });
  it("tools lift local to fast", () => {
    expect(applyPolicy(cfg, { ...base, trivial_ack: 0.95 }, { ...code, has_tools: true }).tier).toBe("fast");
  });
  it("low confidence and retries each move one tier up", () => {
    expect(applyPolicy(cfg, { ...base, difficulty: 0.3, difficulty_confidence: 0.4 }, code).tier).toBe("mid");
    expect(applyPolicy(cfg, { ...base, difficulty: 0.3 }, { ...code, retries: 1 }).tier).toBe("mid");
    expect(applyPolicy(cfg, { ...base, difficulty: 0.3, difficulty_confidence: 0.4 }, { ...code, retries: 1 }).tier).toBe("flagship");
  });
  it("caps at the top tier", () => {
    expect(applyPolicy(cfg, { ...base, difficulty: 1.9, difficulty_confidence: 0.1 }, { ...code, retries: 3 }).tier).toBe("flagship");
  });
});

describe("estimateOutputTokens", () => {
  it("maps buckets to token counts", () => {
    expect(estimateOutputTokens(0.1)).toBe(50);
    expect(estimateOutputTokens(1.0)).toBe(400);
    expect(estimateOutputTokens(1.9)).toBe(2000);
  });
});
