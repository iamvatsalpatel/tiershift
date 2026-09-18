/** Answer gate: after a fast-tier answer, one Jev call; below threshold retry one tier up; everything billed is logged. */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "./router.js";
import type { Config } from "./types.js";
import type { Provider } from "./providers/index.js";

const cfg = (gate: Config["gate"]): Config => ({
  providers: { o: { type: "openai-compatible", base_url: "http://localhost:1/v1" } },
  tiers: { fast: ["o/f"], mid: ["o/m"], flagship: ["o/x"] },
  rules: [{ default: "fast" }],
  models: { "o/f": { price: { input: 1, output: 1 } }, "o/m": { price: { input: 10, output: 10 } }, "o/x": { price: { input: 100, output: 100 } } },
  jev: { model: "jev-1.13.0" }, gate,
});
/** Fake Jev: routing questions get easy signals; the gate question returns `addresses`. */
function jev(addresses: number) {
  const calls: string[] = [];
  const noul = (v: number) => ({ type: "noul" as const, noul: v });
  const score = (v: number) => ({ type: "score" as const, score: v, confidence: 0.9, legend: {}, probabilities: {} });
  return { calls, client: { async systemOne(req: any) {
    if ("addresses" in req.questions) { calls.push("gate"); return { model: "fake", usage: { input_tokens: 380, output_tokens: 5 }, answers: { addresses: noul(addresses) } } as any; }
    calls.push("route");
    return { model: "fake", usage: { input_tokens: 900, output_tokens: 30 }, answers: { difficulty: score(0.1), needs_reasoning: noul(0), stakes: score(0), domain: { type: "choice", choice: "general", confidence: 0.9, probabilities: {} }, has_code: noul(0), ambiguous: noul(0), output_length: score(0), creative: noul(0), safety_sensitive: noul(0), trivial_ack: noul(0), mid_tier_ok: noul(0.9) } } as any;
  } } };
}
const provider = (): Provider & { calls: string[] } => { const calls: string[] = []; return { name: "o", calls, async complete(req) { calls.push(req.model); return { text: `${req.model} says hi`, toolCalls: [], finishReason: "stop", usage: { inputTokens: 100, outputTokens: 100 }, servedModel: req.model, latencyMs: 5, raw: {} }; } }; };
const logDir = () => join(mkdtempSync(join(tmpdir(), "gate-")), "d.jsonl");

describe("answer gate", () => {
  it("is off by default: no gate call, served answer cost only", async () => {
    const j = jev(0.1), p = provider(), log = logDir();
    const r = await createRouter({ config: cfg(undefined), log, typesafeApiKey: "t", __jevClient: j.client, __providers: { o: p } } as any).complete({ messages: [{ role: "user", content: "hi" }] });
    expect(j.calls).toEqual(["route"]); expect(p.calls).toEqual(["f"]); expect(r.gate).toBeNull();
    expect(r.cost_usd).toBeCloseTo(0.0002); expect(r.total_cost_usd).toBeCloseTo(0.0002);
  });
  it("passes: one gate call, same answer, gate cost added to total", async () => {
    const j = jev(0.9), p = provider(), log = logDir();
    const r = await createRouter({ config: cfg({ enabled: true, threshold: 0.5 }), log, typesafeApiKey: "t", __jevClient: j.client, __providers: { o: p } } as any).complete({ messages: [{ role: "user", content: "hi" }] });
    expect(j.calls).toEqual(["route", "gate"]); expect(p.calls).toEqual(["f"]);
    expect(r.gate).toMatchObject({ addresses: 0.9, threshold: 0.5, passed: true }); expect(r.model).toBe("o/f"); expect(r.fell_back).toBe(false);
    expect(r.total_cost_usd!).toBeGreaterThan(r.cost_usd!); expect(r.total_cost_usd!).toBeCloseTo(0.0002 + 380 * 0.042 / 1e6, 8);
    const entry = JSON.parse(readFileSync(log, "utf8").trim()); expect(entry.gate_addresses).toBe(0.9); expect(entry.cost_usd).toBeCloseTo(r.total_cost_usd!, 8);
  });
  it("fails: retries one tier up, bills both answers, logs the fallback tier and a reason line", async () => {
    const j = jev(0.2), p = provider(), log = logDir();
    const r = await createRouter({ config: cfg({ enabled: true, threshold: 0.5 }), log, typesafeApiKey: "t", __jevClient: j.client, __providers: { o: p } } as any).complete({ messages: [{ role: "user", content: "hi" }] });
    expect(p.calls).toEqual(["f", "m"]); expect(r.model).toBe("o/m"); expect(r.fell_back).toBe(true); expect(r.text).toBe("m says hi");
    expect(r.attempts.map((a) => a.ok)).toEqual([false, true]); expect(r.attempts[0].error).toMatch(/gate:addresses 0.20 < 0.5/);
    expect(r.decision.reason.join("\n")).toMatch(/gate: P\(addresses\)=0.20 < 0.5 on o\/f → retry on o\/m/);
    // total = fast answer 0.0002 + gate + mid answer 0.002; the mid answer is not gated (no next candidate... actually flagship exists) -> gate runs only for tiers in the list
    expect(r.total_cost_usd!).toBeCloseTo(0.0002 + 380 * 0.042 / 1e6 + 0.002, 8);
    const entry = JSON.parse(readFileSync(log, "utf8").trim()); expect(entry.tier).toBe("mid"); expect(entry.fell_back).toBe(true); expect(entry.cost_usd).toBeCloseTo(r.total_cost_usd!, 8);
  });
  it("gates only the listed tiers and never gates tool calls or the last candidate", async () => {
    const j = jev(0.1); const p = provider(); const withTools: Provider = { name: "o", async complete(req) { return { text: "", toolCalls: [{ id: "1", name: "t", arguments: "{}" }], finishReason: "tool_calls", usage: { inputTokens: 1, outputTokens: 1 }, servedModel: req.model, latencyMs: 1, raw: {} }; } };
    const r1 = await createRouter({ config: cfg({ enabled: true, tiers: ["mid"] }), typesafeApiKey: "t", log: false, __jevClient: j.client, __providers: { o: p } } as any).complete({ messages: [{ role: "user", content: "hi" }] });
    expect(r1.gate).toBeNull(); expect(p.calls).toEqual(["f"]);
    const j2 = jev(0.1);
    const r2 = await createRouter({ config: cfg({ enabled: true }), typesafeApiKey: "t", log: false, __jevClient: j2.client, __providers: { o: withTools } } as any).complete({ messages: [{ role: "user", content: "hi" }] });
    expect(r2.gate).toBeNull(); expect(j2.calls).toEqual(["route"]);
  });
  it("rejects a bad gate config at load time", async () => {
    const { validate } = await import("./config.js");
    expect(() => validate(cfg({ threshold: 1.5 }))).toThrow(/gate.threshold/);
    expect(() => validate(cfg({ tiers: ["nope"] }))).toThrow(/gate.tiers: unknown tier "nope"/);
  });
});
