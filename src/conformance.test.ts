/** The TypeScript side of the cross-language contract in conformance/. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { applyPolicy } from "./policy.js";
import { validate } from "./config.js";
import type { Config, Signals, CodeSignals } from "./types.js";
import type { LogEntry } from "./log.js";

const dir = join(process.cwd(), "conformance");
const fixture = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")) as { policy: string; cases: { name: string; policy?: string; signals: Signals; code_signals: CodeSignals; expected_tier: string; reason_contains: string[] }[] };
const policies = new Map<string, Config>();
const policyFor = (file: string): Config => {
  if (!policies.has(file)) policies.set(file, parse(readFileSync(join(dir, file), "utf8")) as Config);
  return policies.get(file)!;
};

describe("conformance: policy", () => {
  it("fixture policies validate", () => {
    for (const file of new Set([fixture.policy, ...fixture.cases.map((c) => c.policy).filter((p): p is string => Boolean(p))])) expect(() => validate(policyFor(file)), file).not.toThrow();
  });
  for (const c of fixture.cases) {
    it(c.name, () => {
      const r = applyPolicy(policyFor(c.policy ?? fixture.policy), c.signals, c.code_signals);
      expect(r.tier).toBe(c.expected_tier);
      for (const frag of c.reason_contains) expect(r.reason.join("\n")).toContain(frag);
    });
  }
});

describe("conformance: log entry shape", () => {
  it("has every field the TypeScript LogEntry type requires", () => {
    const e = JSON.parse(readFileSync(join(dir, "log-entry.json"), "utf8")) as LogEntry;
    const required: (keyof LogEntry)[] = ["ts", "kind", "model", "tier", "requested_tier", "degraded", "fell_back", "confidence", "signals", "code_signals", "reason", "est_cost_usd", "cost_usd", "input_tokens", "output_tokens", "jev_latency_ms", "jev_input_tokens", "model_latency_ms"];
    for (const k of required) expect(e, `missing ${k}`).toHaveProperty(k);
    expect(Object.keys(e.signals).sort()).toEqual(["ambiguous", "creative", "difficulty", "difficulty_confidence", "domain", "domain_confidence", "has_code", "mid_tier_ok", "needs_reasoning", "output_length", "safety_sensitive", "stakes", "stakes_confidence", "trivial_ack"]);
  });
});
