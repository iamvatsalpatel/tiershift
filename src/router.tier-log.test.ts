/** The logged tier must be the tier the decision chose, even when one model appears in several tiers. */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "./router.js";
import type { Config } from "./types.js";
import type { Provider } from "./providers/index.js";
import { ProviderError } from "./providers/index.js";

const sameModelEverywhere: Config = {
  providers: { o: { type: "openai-compatible", base_url: "http://localhost:1/v1" } },
  tiers: { local: ["o/m"], fast: ["o/m"], mid: ["o/m"], flagship: ["o/m"] },
  rules: [{ when: "difficulty < 0.5", tier: "fast" }, { when: "difficulty < 1.3", tier: "mid" }, { default: "flagship" }],
  models: { "o/m": { price: { input: 0, output: 0 } } },
  jev: { model: "jev-1.13.0" },
};
const twoTiers: Config = {
  providers: { o: { type: "openai-compatible", base_url: "http://localhost:1/v1" } },
  tiers: { fast: ["o/a"], mid: ["o/b"] },
  rules: [{ default: "fast" }],
  models: { "o/a": { price: { input: 0, output: 0 } }, "o/b": { price: { input: 0, output: 0 } } },
  jev: { model: "jev-1.13.0" },
};
const jev = (difficulty: number) => ({
  async systemOne() {
    const noul = (v: number) => ({ type: "noul" as const, noul: v });
    const score = (v: number) => ({ type: "score" as const, score: v, confidence: 0.9, legend: {}, probabilities: {} });
    return { model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 10 },
      answers: { difficulty: score(difficulty), needs_reasoning: noul(0), stakes: score(0), domain: { type: "choice" as const, choice: "general", confidence: 0.9, probabilities: {} }, has_code: noul(0), ambiguous: noul(0), output_length: score(0), creative: noul(0), safety_sensitive: noul(0), trivial_ack: noul(0), mid_tier_ok: noul(0.5) } } as any;
  },
});
const provider = (failFirst = false): Provider => {
  let n = 0;
  return { name: "o", async complete(req) { n++; if (failFirst && n === 1) throw new ProviderError("o", 503, "down"); return { text: "ok", toolCalls: [], finishReason: "stop", usage: { inputTokens: 5, outputTokens: 2 }, servedModel: req.model, latencyMs: 1, raw: {} }; } };
};

describe("logged tier matches the decision", () => {
  it("uses the decided tier, not the first tier that lists the model", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "ts-")), "d.jsonl");
    const r = createRouter({ config: sameModelEverywhere, log, typesafeApiKey: "test", __jevClient: jev(1.0), __providers: { o: provider() } } as any);
    const res = await r.complete({ messages: [{ role: "user", content: "x" }] });
    expect(res.decision.tier).toBe("mid");
    const entry = JSON.parse(readFileSync(log, "utf8").trim());
    expect(entry.kind).toBe("complete");
    expect(entry.tier).toBe("mid");
  });
  it("records the fallback's tier when the fallback answered", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "ts-")), "d.jsonl");
    const r = createRouter({ config: twoTiers, log, typesafeApiKey: "test", __jevClient: jev(0.1), __providers: { o: provider(true) } } as any);
    const res = await r.complete({ messages: [{ role: "user", content: "x" }] });
    expect(res.fell_back).toBe(true); expect(res.decision.fallback_tier).toBe("mid");
    const entry = JSON.parse(readFileSync(log, "utf8").trim());
    expect(entry.tier).toBe("mid"); expect(entry.fell_back).toBe(true);
  });
});
