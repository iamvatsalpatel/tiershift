/** Router tests with a fake Jev client and fake providers. No network. */
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRouter } from "./router.js";
import type { JevClient } from "./signals.js";
import type { CompletionRequest, CompletionResult, Provider } from "./providers/index.js";
import { ProviderError } from "./providers/index.js";
import type { Config, Signals } from "./types.js";

const baseSignals: Signals = {
  difficulty: 0.9, difficulty_confidence: 0.9, needs_reasoning: 0.2, stakes: 0.2, stakes_confidence: 0.9, domain: "code", domain_confidence: 0.9,
  has_code: 0.8, ambiguous: 0.1, output_length: 1.0, creative: 0, safety_sensitive: 0, trivial_ack: 0, mid_tier_ok: 0.6,
};

/** Fake Jev: answers every question from a Signals object. */
function fakeJev(sig: Partial<Signals> = {}): JevClient {
  const s = { ...baseSignals, ...sig };
  const score = (v: number, conf: number) => ({ type: "score", score: v, confidence: conf, legend: {}, probabilities: {} });
  const noul = (v: number) => ({ type: "noul", noul: v });
  return {
    systemOne: (async () => ({
      model: "fake", usage: { input_tokens: 900, output_tokens: 30 },
      answers: {
        difficulty: score(s.difficulty, s.difficulty_confidence), needs_reasoning: noul(s.needs_reasoning), stakes: score(s.stakes, s.stakes_confidence),
        domain: { type: "choice", choice: s.domain, confidence: s.domain_confidence, probabilities: {} }, has_code: noul(s.has_code), ambiguous: noul(s.ambiguous),
        output_length: score(s.output_length, 0.9), creative: noul(s.creative), safety_sensitive: noul(s.safety_sensitive), trivial_ack: noul(s.trivial_ack), mid_tier_ok: noul(s.mid_tier_ok),
      },
    })) as unknown as JevClient["systemOne"],
  };
}

type Behavior = { text?: string; finish?: string; error?: ProviderError | Error; outTokens?: number };
/** Fake provider that records requests and answers per model id. */
function fakeProvider(name: string, behaviors: Record<string, Behavior> = {}): Provider & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    name, calls,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      calls.push(req);
      const b = behaviors[req.model] ?? {};
      if (b.error) throw b.error;
      return { text: b.text ?? `answer from ${req.model}`, toolCalls: [], finishReason: b.finish ?? "stop", usage: { inputTokens: 100, outputTokens: b.outTokens ?? 50 }, servedModel: req.model, latencyMs: 5, raw: {} };
    },
  };
}

const cfg = (): Config => ({
  providers: { loc: { type: "openai-compatible", base_url: "http://localhost:1/v1" }, cloud: { type: "openai-compatible", base_url: "https://x/v1", api_key_env: "CLOUD_KEY" } },
  tiers: { local: ["loc/small"], fast: ["cloud/fast"], mid: ["cloud/mid"], flagship: ["cloud/big"] },
  models: {
    "loc/small": { price: { input: 0, output: 0 }, context: 8000, caps: ["tools"] },
    "cloud/fast": { price: { input: 0.2, output: 1 }, context: 128000, caps: ["json"] },
    "cloud/mid": { price: { input: 2, output: 10 }, context: 200000, caps: ["tools", "reasoning"] },
    "cloud/big": { price: { input: 10, output: 50 }, context: 1000000, caps: ["tools", "reasoning"] },
  },
  rules: [{ when: "trivial_ack > 0.8", tier: "local" }, { when: "difficulty < 0.5", tier: "fast" }, { when: "difficulty < 1.3", tier: "mid" }, { default: "flagship" }],
  overrides: [{ when: "stakes > 1.5", at_least: "flagship" }, { when: "has_tools and tier == local", at_least: "fast" }],
  budget: { max_cost_per_call: 1 },
  fallback: "up",
  jev: { model: "jev-test" },
});
const env = { CLOUD_KEY: "k" };
const tmpLog = () => join(mkdtempSync(join(tmpdir(), "ts-router-")), "d.jsonl");
const msg = (content: string) => [{ role: "user" as const, content }];

describe("route()", () => {
  it("applies rules and reports reasons and fallback", async () => {
    const r = createRouter({ config: cfg(), env, __jevClient: fakeJev({ difficulty: 0.9 }), __providers: {}, log: false });
    const d = await r.route({ messages: msg("write a parser") });
    expect(d.tier).toBe("mid"); expect(d.model).toBe("cloud/mid"); expect(d.fallback).toBe("cloud/big");
    expect(d.reason).toContain('rule "difficulty < 1.3" → mid'); expect(d.requested_tier).toBe("mid"); expect(d.degraded).toBe(false);
    expect(d.signals.mid_tier_ok).toBe(0.6); expect(d.jev_input_tokens).toBe(900);
  });
  it("applies overrides", async () => {
    const r = createRouter({ config: cfg(), env, __jevClient: fakeJev({ difficulty: 0.2, stakes: 1.9 }), __providers: {}, log: false });
    const d = await r.route({ messages: msg("wire $1M") });
    expect(d.tier).toBe("flagship"); expect(d.reason.join(" ")).toContain("at_least flagship");
  });
  it("skips a model whose context is too small and walks up", async () => {
    const r = createRouter({ config: cfg(), env, __jevClient: fakeJev({ trivial_ack: 0.95, difficulty: 0 }), __providers: {}, log: false });
    const d = await r.route({ messages: msg("x".repeat(40000)) }); // ~10k tokens > 8000 context of loc/small
    expect(d.requested_tier).toBe("local"); expect(d.tier).toBe("fast");
    expect(d.reason.join(" ")).toMatch(/skip loc\/small: \d+ tokens exceeds context 8000/); expect(d.reason).toContain("walked up to fast");
  });
  it("skips a model without the tools capability when tools are present", async () => {
    const r = createRouter({ config: cfg(), env, __jevClient: fakeJev({ difficulty: 0.2 }), __providers: {}, log: false });
    const d = await r.route({ messages: msg("call the api"), tools: [{ name: "get" }] });
    expect(d.requested_tier).toBe("fast"); expect(d.tier).toBe("mid"); expect(d.reason).toContain("skip cloud/fast: no tools capability");
  });
  it("skips a model over the per-call budget", async () => {
    const r = createRouter({ config: cfg(), env, __jevClient: fakeJev({ difficulty: 1.9, output_length: 1.9 }), __providers: {}, log: false });
    // big: 100k in * $10 + 2000 out * $50 = $1.10 > budget 0.5 → skipped; nothing above → degrade down to mid ($0.22), flagged.
    const over = await r.route({ messages: msg("x".repeat(400000)), maxCost: 0.5 });
    expect(over.reason.join(" ")).toMatch(/skip cloud\/big: est \$1\.1\d+ > budget \$0\.5/);
    expect(over.model).toBe("cloud/mid"); expect(over.degraded).toBe(true);
    // with degrade off, the same request is an error
    const strict = createRouter({ config: { ...cfg(), degrade: false }, env, __jevClient: fakeJev({ difficulty: 1.9, output_length: 1.9 }), __providers: {}, log: false });
    await expect(strict.route({ messages: msg("x".repeat(400000)), maxCost: 0.5 })).rejects.toThrow(/No model fits/);
    const d = await r.route({ messages: msg("x".repeat(400000)), maxCost: 5 });
    expect(d.model).toBe("cloud/big"); expect(d.est_cost_usd).toBeCloseTo(1.1, 1);
  });
  it("degrades to the best available lower tier when nothing above has a key, and flags it", async () => {
    const r = createRouter({ config: cfg(), env: {}, __jevClient: fakeJev({ difficulty: 1.9 }), __providers: {}, log: false });
    const d = await r.route({ messages: msg("prove it") });
    expect(d.requested_tier).toBe("flagship"); expect(d.tier).toBe("local"); expect(d.degraded).toBe(true); expect(d.fallback).toBeNull();
    expect(d.reason.at(-1)).toMatch(/^DEGRADED/);
  });
  it("throws instead of degrading when degrade is false", async () => {
    const r = createRouter({ config: { ...cfg(), degrade: false }, env: {}, __jevClient: fakeJev({ difficulty: 1.9 }), __providers: {}, log: false });
    await expect(r.route({ messages: msg("prove it") })).rejects.toThrow(/No model fits/);
  });
  it("uses the pinned Jev model when the config omits one", () => {
    const c = cfg(); delete c.jev;
    let seen: string | undefined;
    const spy: JevClient = { systemOne: ((req: { model?: string }) => { seen = req.model; return fakeJev().systemOne(req as never); }) as unknown as JevClient["systemOne"] };
    const r = createRouter({ config: c, env, __jevClient: spy, __providers: {}, log: false });
    return r.route({ messages: msg("hi") }).then(() => expect(seen).toBe("jev-1.13.0"));
  });
  it("writes a route log entry with the tag and without message text", async () => {
    const log = tmpLog();
    const r = createRouter({ config: cfg(), env, __jevClient: fakeJev(), __providers: {}, log });
    await r.route({ messages: msg("the secret phrase is xyzzy"), tag: "agent-7" });
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const e = JSON.parse(lines[0]);
    expect(e).toMatchObject({ kind: "route", tier: "mid", model: "cloud/mid", tag: "agent-7", cost_usd: null });
    expect(lines[0]).not.toContain("xyzzy");
  });
  it("does not create a log when logging is off", async () => {
    const log = tmpLog();
    const r = createRouter({ config: { ...cfg(), log: { enabled: false, path: log } }, env, __jevClient: fakeJev(), __providers: {} });
    await r.route({ messages: msg("hi") });
    expect(r.logPath).toBeNull(); expect(existsSync(log)).toBe(false);
  });
});

describe("complete()", () => {
  it("calls the chosen model, merges per-model params, and logs actual usage", async () => {
    const c = cfg(); c.models!["cloud/mid"].params = { reasoning_effort: "none" };
    const cloud = fakeProvider("cloud"); const log = tmpLog();
    const r = createRouter({ config: c, env, __jevClient: fakeJev({ difficulty: 0.9 }), __providers: { cloud }, log });
    const res = await r.complete({ messages: msg("write a parser"), maxTokens: 2000, tag: "t1" });
    expect(res.model).toBe("cloud/mid"); expect(res.fell_back).toBe(false); expect(res.text).toBe("answer from mid");
    expect(cloud.calls[0].params).toEqual({ reasoning_effort: "none" }); expect(cloud.calls[0].maxTokens).toBe(2000);
    expect(res.cost_usd).toBeCloseTo((100 * 2 + 50 * 10) / 1e6);
    const e = JSON.parse(readFileSync(log, "utf8").trim());
    expect(e).toMatchObject({ kind: "complete", model: "cloud/mid", tag: "t1", input_tokens: 100, output_tokens: 50, fell_back: false });
    expect(e.cost_usd).toBeCloseTo(res.cost_usd as number);
  });
  it("falls back one tier up on a retryable provider error", async () => {
    const cloud = fakeProvider("cloud", { mid: { error: new ProviderError("cloud", 503, "overloaded") } });
    const r = createRouter({ config: cfg(), env, __jevClient: fakeJev({ difficulty: 0.9 }), __providers: { cloud }, log: false });
    const res = await r.complete({ messages: msg("write a parser") });
    expect(res.model).toBe("cloud/big"); expect(res.fell_back).toBe(true);
    expect(res.attempts.map((a) => a.ok)).toEqual([false, true]); expect(res.attempts[0].status).toBe(503);
  });
  it("still records a 4xx and moves on, surfacing the status", async () => {
    const cloud = fakeProvider("cloud", { mid: { error: new ProviderError("cloud", 400, "bad request") }, big: { error: new ProviderError("cloud", 400, "bad request") } });
    const r = createRouter({ config: cfg(), env, __jevClient: fakeJev({ difficulty: 0.9 }), __providers: { cloud }, log: false });
    await expect(r.complete({ messages: msg("write a parser") })).rejects.toThrow(/every candidate failed.*cloud\/mid: cloud: bad request.*cloud\/big/);
  });
  it("treats an empty answer with finish reason length as a failure and retries on the fallback", async () => {
    const cloud = fakeProvider("cloud", { mid: { text: "", finish: "length", outTokens: 4096 } });
    const r = createRouter({ config: cfg(), env, __jevClient: fakeJev({ difficulty: 0.9 }), __providers: { cloud }, log: false });
    const res = await r.complete({ messages: msg("design a system"), maxTokens: 4096 });
    expect(res.model).toBe("cloud/big"); expect(res.fell_back).toBe(true);
    expect(res.attempts[0].error).toMatch(/^cloud: empty_answer:length/);
  });
  it("raises max_tokens to the floor for reasoning models and says so", async () => {
    const cloud = fakeProvider("cloud");
    const r = createRouter({ config: cfg(), env, __jevClient: fakeJev({ difficulty: 0.9 }), __providers: { cloud }, log: false });
    const res = await r.complete({ messages: msg("x"), maxTokens: 200 });
    expect(cloud.calls[0].maxTokens).toBe(1024); expect(res.decision.reason).toContain("raised max_tokens to 1024 for reasoning model cloud/mid");
    const c2 = cfg(); c2.defaults = { min_output_tokens: 3000 };
    const cloud2 = fakeProvider("cloud");
    await createRouter({ config: c2, env, __jevClient: fakeJev({ difficulty: 0.9 }), __providers: { cloud: cloud2 }, log: false }).complete({ messages: msg("x"), maxTokens: 200 });
    expect(cloud2.calls[0].maxTokens).toBe(3000);
  });
  it("does not raise max_tokens for a model without the reasoning capability", async () => {
    const cloud = fakeProvider("cloud");
    const r = createRouter({ config: cfg(), env, __jevClient: fakeJev({ difficulty: 0.2 }), __providers: { cloud }, log: false });
    await r.complete({ messages: msg("x"), maxTokens: 200 });
    expect(cloud.calls[0].model).toBe("fast"); expect(cloud.calls[0].maxTokens).toBe(200);
  });
});
