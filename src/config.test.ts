import { describe, expect, it } from "vitest";
import { availableTiers, loadConfig, mergeModelMeta, splitModel, validate } from "./config.js";

describe("mergeModelMeta", () => {
  const bundled = { "a/x": { price: { input: 1, output: 2 }, context: 1000, caps: ["tools"] } };
  it("keeps bundled price when the override only sets params", () => {
    const m = mergeModelMeta(bundled, { "a/x": { params: { thinking: { type: "disabled" } } } });
    expect(m["a/x"]).toEqual({ price: { input: 1, output: 2 }, context: 1000, caps: ["tools"], params: { thinking: { type: "disabled" } } });
  });
  it("lets an override replace the price", () => {
    expect(mergeModelMeta(bundled, { "a/x": { price: { input: 5, output: 6 } } })["a/x"].price).toEqual({ input: 5, output: 6 });
  });
  it("adds models that are not bundled", () => {
    expect(mergeModelMeta(bundled, { "b/y": { context: 8 } })["b/y"]).toEqual({ context: 8 });
  });
});

describe("splitModel", () => {
  it("splits on the first slash only", () => {
    expect(splitModel("ollama/qwen2.5:7b")).toEqual({ provider: "ollama", model: "qwen2.5:7b" });
    expect(splitModel("openrouter/anthropic/claude-sonnet-5")).toEqual({ provider: "openrouter", model: "anthropic/claude-sonnet-5" });
    expect(() => splitModel("nope")).toThrow(/provider\/model/);
  });
});

describe("validate", () => {
  const base = { providers: { p: { type: "openai-compatible" as const } }, tiers: { t: ["p/m"] }, rules: [{ default: "t" }] };
  it("accepts a minimal config", () => { expect(() => validate(base)).not.toThrow(); });
  it("rejects a model with an unknown provider", () => {
    expect(() => validate({ ...base, tiers: { t: ["zzz/m"] } })).toThrow(/unknown provider "zzz"/);
  });
  it("rejects empty sections", () => {
    expect(() => validate({ ...base, rules: [] })).toThrow(/rules/);
    expect(() => validate({ ...base, tiers: {} })).toThrow(/tiers/);
  });
});

describe("availableTiers", () => {
  const cfg = { providers: { a: { type: "anthropic" as const, api_key_env: "A_KEY" }, o: { type: "openai-compatible" as const } }, tiers: { fast: ["a/x", "o/y"], top: ["a/z"] }, rules: [{ default: "top" }] };
  it("drops models whose provider key is missing and keeps key-less local providers", () => {
    expect(availableTiers(cfg, {})).toEqual({ fast: ["o/y"], top: ["a/z"] });
    expect(availableTiers(cfg, { A_KEY: "k" })).toEqual({ fast: ["a/x", "o/y"], top: ["a/z"] });
  });
});

describe("validate: load-time policy checks", () => {
  const ok = () => ({
    providers: { p: { type: "openai-compatible" as const } },
    tiers: { fast: ["p/f"], mid: ["p/m"], flagship: ["p/x"] },
    rules: [{ when: "difficulty < 0.5", tier: "fast" }, { when: "difficulty < 1.3", tier: "mid" }, { default: "flagship" }],
    overrides: [{ when: "stakes > 1.5", at_least: "flagship" }, { when: "mid_tier_ok > 0.8 and stakes < 1.5", at_most: "mid" }, { when: "retries >= 1", up: 1 }],
  });
  it("accepts a full valid policy", () => { expect(() => validate(ok())).not.toThrow(); });
  it("names the location and suggests a fix for a misspelled signal", () => {
    const c = ok(); c.overrides[1] = { when: "difficlty > 1", at_least: "mid" };
    expect(() => validate(c)).toThrow('config: overrides[1].when: unknown signal "difficlty" (did you mean "difficulty"?)');
  });
  it("rejects an unparsable condition and quotes it", () => {
    const c = ok(); c.rules[0] = { when: "difficulty <> 0.5", tier: "fast" };
    expect(() => validate(c)).toThrow(/config: rules\[0\]\.when: cannot parse "difficulty <> 0.5"/);
  });
  it("rejects unknown tiers in tier, default, at_least, and at_most, with a suggestion", () => {
    let c = ok(); c.rules[0].tier = "fsat";
    expect(() => validate(c)).toThrow('config: rules[0].tier: unknown tier "fsat" (did you mean "fast"?)');
    c = ok(); c.rules[2] = { default: "flagshp" };
    expect(() => validate(c)).toThrow(/rules\[2\]\.default: unknown tier "flagshp"/);
    c = ok(); c.overrides[0].at_least = "top";
    expect(() => validate(c)).toThrow(/overrides\[0\]\.at_least: unknown tier "top"/);
    c = ok(); c.overrides[1].at_most = "midd";
    expect(() => validate(c)).toThrow('config: overrides[1].at_most: unknown tier "midd" (did you mean "mid"?)');
  });
  it("rejects a non-positive or fractional up", () => {
    for (const bad of [0, -1, 1.5]) { const c = ok(); c.overrides[2] = { when: "retries >= 1", up: bad }; expect(() => validate(c)).toThrow(/overrides\[2\]\.up: must be a positive integer/); }
  });
  it("rejects a rule with neither when+tier nor default", () => {
    let c = ok(); c.rules[0] = { when: "difficulty < 0.5" } as never;
    expect(() => validate(c)).toThrow(/rules\[0\]: a rule needs both `when` and `tier`, or a single `default`/);
    c = ok(); c.rules[0] = { tier: "fast" } as never;
    expect(() => validate(c)).toThrow(/rules\[0\]: a rule needs both/);
  });
  it("rejects a default that is not last, or that carries when/tier", () => {
    let c = ok(); c.rules = [{ default: "flagship" }, { when: "difficulty < 0.5", tier: "fast" }];
    expect(() => validate(c)).toThrow(/rules\[0\]: `default` must be the last rule/);
    c = ok(); c.rules[2] = { default: "flagship", when: "difficulty > 1", tier: "mid" } as never;
    expect(() => validate(c)).toThrow(/rules\[2\]: a `default` rule cannot also have `when` or `tier`/);
  });
  it("rejects an override with no action", () => {
    const c = ok(); c.overrides[0] = { when: "stakes > 1.5" } as never;
    expect(() => validate(c)).toThrow(/overrides\[0\]: needs one of `at_least`, `at_most`, or `up`/);
  });
  it("rejects bad enum values and a bad min_output_tokens", () => {
    expect(() => validate({ ...ok(), budget: { prefer: "random" as never } })).toThrow(/budget\.prefer/);
    expect(() => validate({ ...ok(), fallback: "sideways" as never })).toThrow(/fallback: must be "up" or "none"/);
    expect(() => validate({ ...ok(), defaults: { min_output_tokens: -5 } })).toThrow(/defaults\.min_output_tokens/);
  });
  it("suggests a provider name for a model with an unknown provider", () => {
    const c = ok(); c.tiers.fast = ["q/f"];
    expect(() => validate(c)).toThrow('config: tiers.fast: model "q/f" uses unknown provider "q" (did you mean "p"?)');
  });
  it("accepts `or`, quoted strings, bare booleans, and every known signal name", () => {
    const c = ok();
    c.overrides.push({ when: 'domain == legal_finance or domain == "medical"', at_least: "mid" }, { when: "has_tools and tier == fast", at_least: "mid" });
    for (const s of ["difficulty", "difficulty_confidence", "needs_reasoning", "stakes", "stakes_confidence", "domain", "domain_confidence", "has_code", "ambiguous", "output_length", "creative", "safety_sensitive", "trivial_ack", "mid_tier_ok", "est_input_tokens", "has_tools", "tool_count", "step", "retries", "turn_count", "tier"]) c.overrides.push({ when: `${s} != 0`, up: 1 });
    expect(() => validate(c)).not.toThrow();
  });
  it("the bundled tiershift.yaml and the bench policies validate", () => {
    expect(() => loadConfig()).not.toThrow();
    expect(() => loadConfig("examples/policies/bolder.yaml")).not.toThrow();
  });
});
