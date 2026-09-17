import { describe, expect, it } from "vitest";
import { availableTiers, mergeModelMeta, splitModel, validate } from "./config.js";

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
