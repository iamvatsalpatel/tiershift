import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy, type ProxyHandle } from "./proxy.js";
import type { LogEntry } from "./log.js";
import { ProviderError, type CompletionRequest, type CompletionResult, type Provider } from "./providers/types.js";
import type { Config, Decision } from "./types.js";

const config: Config = {
  providers: { p: { type: "openai-compatible" }, q: { type: "openai-compatible" }, a: { type: "anthropic", api_key_env: "A_KEY" } },
  tiers: { fast: ["p/small"], mid: ["q/medium"], flagship: ["a/big"] },
  rules: [{ default: "fast" }],
  defaults: { max_tokens: 256 },
  models: { "p/small": { params: { reasoning_effort: "none" } } },
};

const decision: Decision = {
  model: "p/small", provider: "p", tier: "fast", tier_index: 0, requested_tier: "fast", degraded: false, fallback: "q/medium",
  signals: { difficulty: 0.2, difficulty_confidence: 0.9, needs_reasoning: 0.1, stakes: 0.1, stakes_confidence: 0.9, domain: "general", domain_confidence: 0.9, has_code: 0, ambiguous: 0, output_length: 0, creative: 0, safety_sensitive: 0, trivial_ack: 0 },
  code_signals: { est_input_tokens: 10, has_tools: false, tool_count: 0, step: null, retries: 0, turn_count: 1 },
  confidence: 0.9, reason: ['rule "difficulty < 0.5" → fast'], est_cost_usd: 0.00001, est_output_tokens: 50, jev_latency_ms: 150, jev_input_tokens: 900,
};

const calls: { provider: string; req: CompletionRequest; stream: boolean }[] = [];
let routeCalls = 0;
let failSmallWith: ProviderError | null = null;

function fakeProvider(name: string, text: string): Provider {
  const result = (req: CompletionRequest): CompletionResult => ({ text, toolCalls: [], finishReason: "stop", usage: { inputTokens: 7, outputTokens: 3 }, servedModel: `${req.model}-served`, latencyMs: 12, raw: {} });
  return {
    name,
    async complete(req) { calls.push({ provider: name, req, stream: false }); if (name === "p" && failSmallWith) throw failSmallWith; return result(req); },
    async streamRaw(req) {
      calls.push({ provider: name, req, stream: true });
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(`data: {"choices":[{"delta":{"content":"he"}}]}\n\n`)); c.enqueue(enc.encode(`data: {"choices":[{"delta":{"content":"llo"}}]}\n\n`)); c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  };
}
const anthropicLike: Provider = { name: "a", async complete(req) { calls.push({ provider: "a", req, stream: false }); return { text: "big", toolCalls: [], finishReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 }, servedModel: "big", latencyMs: 1, raw: {} }; } };

const logDir = mkdtempSync(join(tmpdir(), "tiershift-proxy-"));
const logPath = join(logDir, "decisions.jsonl");
const readLogLines = (): LogEntry[] => (existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LogEntry) : []);

const router = {
  config,
  logPath,
  providers: { p: fakeProvider("p", "small says hi"), q: fakeProvider("q", "medium says hi"), a: anthropicLike },
  available: () => ({ fast: ["p/small"], mid: ["q/medium"], flagship: ["a/big"] }),
  async route() { routeCalls++; return decision; },
};

let h: ProxyHandle;
beforeAll(async () => { h = await startProxy({ router, port: 0 }); });
afterAll(async () => { await h.close(); rmSync(logDir, { recursive: true, force: true }); });
beforeEach(() => { rmSync(logPath, { force: true }); });
const post = (body: unknown, raw = false) => fetch(`${h.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: raw ? (body as string) : JSON.stringify(body) });

describe("proxy", () => {
  it("routes model auto and returns an OpenAI completion with decision headers", async () => {
    calls.length = 0; routeCalls = 0;
    const res = await post({ model: "auto", messages: [{ role: "user", content: "hi" }], max_tokens: 33, top_p: 0.5 });
    expect(res.status).toBe(200);
    const j = await res.json() as any;
    expect(j.object).toBe("chat.completion"); expect(j.model).toBe("p/small"); expect(j.choices[0].message).toEqual({ role: "assistant", content: "small says hi" });
    expect(j.choices[0].finish_reason).toBe("stop"); expect(j.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
    expect(res.headers.get("x-tiershift-model")).toBe("p/small"); expect(res.headers.get("x-tiershift-tier")).toBe("fast");
    expect(res.headers.get("x-tiershift-fallback")).toBe("q/medium"); expect(res.headers.get("x-tiershift-confidence")).toBe("0.900");
    expect(res.headers.get("x-tiershift-jev-ms")).toBe("150"); expect(res.headers.get("x-tiershift-reason")).toBe('rule "difficulty < 0.5" -> fast');
    expect(res.headers.get("x-tiershift-served-model")).toBe("small-served");
    expect(routeCalls).toBe(1); expect(calls).toHaveLength(1);
    expect(calls[0].req).toMatchObject({ model: "small", maxTokens: 33, params: { top_p: 0.5, reasoning_effort: "none" } });
    for (const k of ["x-tiershift-model", "x-tiershift-reason"]) expect(res.headers.get(k)).not.toContain("hi");
  });
  it("treats a missing model and auto:<tag> as auto, and passes the tag to route", async () => {
    routeCalls = 0;
    expect((await post({ messages: [{ role: "user", content: "x" }] })).status).toBe(200);
    expect((await post({ model: "auto:billing", messages: [{ role: "user", content: "x" }] })).status).toBe(200);
    expect(routeCalls).toBe(2);
  });
  it("bypasses routing for an explicit configured model id", async () => {
    calls.length = 0; routeCalls = 0;
    const res = await post({ model: "q/medium", messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(200); expect(routeCalls).toBe(0); expect(calls[0].provider).toBe("q");
    expect(res.headers.get("x-tiershift-tier")).toBe("explicit"); expect(res.headers.get("x-tiershift-jev-ms")).toBe("0");
    expect(((await res.json()) as any).choices[0].message.content).toBe("medium says hi");
  });
  it("returns 404 for an unknown model id", async () => {
    const res = await post({ model: "nope/none", messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(404); expect(((await res.json()) as any).error.code).toBe("model_not_found");
  });
  it("falls back to the next candidate on a retryable provider error and flags it", async () => {
    calls.length = 0; failSmallWith = new ProviderError("p", 503, "down");
    const res = await post({ model: "auto", messages: [{ role: "user", content: "x" }] });
    failSmallWith = null;
    expect(res.status).toBe(200); expect(res.headers.get("x-tiershift-fell-back")).toBe("true"); expect(res.headers.get("x-tiershift-model")).toBe("q/medium");
    expect(calls.map((c) => c.provider)).toEqual(["p", "q"]);
  });
  it("passes a provider 4xx through with its status and no fallback", async () => {
    calls.length = 0; failSmallWith = new ProviderError("p", 400, "bad param");
    const res = await post({ model: "auto", messages: [{ role: "user", content: "x" }] });
    failSmallWith = null;
    expect(res.status).toBe(400); expect(((await res.json()) as any).error.message).toContain("bad param"); expect(calls).toHaveLength(1);
  });
  it("pipes an SSE stream from an openai-compatible provider with decision headers first", async () => {
    calls.length = 0;
    const res = await post({ model: "auto", stream: true, messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(200); expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-tiershift-tier")).toBe("fast"); expect(res.headers.get("x-tiershift-model")).toBe("p/small");
    const text = await res.text();
    expect(text).toContain('"content":"he"'); expect(text).toContain('"content":"llo"'); expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    expect(calls[0]).toMatchObject({ provider: "p", stream: true });
  });
  it("rejects streaming for a provider without streamRaw with a clear 400", async () => {
    const res = await post({ model: "a/big", stream: true, messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(400); const j = (await res.json()) as any;
    expect(j.error.code).toBe("stream_unsupported"); expect(j.error.message).toContain("openai-compatible providers only");
  });
  it("returns OpenAI-style 400 errors for bad JSON and bad messages", async () => {
    const bad = await post("{not json", true);
    expect(bad.status).toBe(400); expect(((await bad.json()) as any).error).toMatchObject({ type: "invalid_request_error", code: "invalid_json" });
    const empty = await post({ model: "auto", messages: [] });
    expect(empty.status).toBe(400); expect(((await empty.json()) as any).error.message).toContain("non-empty");
    const role = await post({ model: "auto", messages: [{ role: "robot", content: "x" }] });
    expect(role.status).toBe(400);
  });
  it("lists auto plus configured models, and answers healthz and 404", async () => {
    const models = (await (await fetch(`${h.url}/v1/models`)).json()) as any;
    expect(models.object).toBe("list"); expect(models.data.map((m: any) => m.id)).toEqual(["auto", "p/small", "q/medium", "a/big"]);
    expect(models.data[1]).toMatchObject({ tier: "fast", available: true });
    expect(((await (await fetch(`${h.url}/healthz`)).json()) as any).ok).toBe(true);
    const nf = await fetch(`${h.url}/nope`); expect(nf.status).toBe(404); expect(((await nf.json()) as any).error.code).toBe("not_found");
  });
  it("converts array content parts and tool definitions", async () => {
    calls.length = 0;
    const res = await post({ model: "q/medium", messages: [{ role: "system", content: "s" }, { role: "user", content: [{ type: "text", text: "part one" }, { type: "image_url", image_url: { url: "x" } }] }], tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object", properties: {} } } }] });
    expect(res.status).toBe(200);
    expect(calls[0].req.messages[1].content).toBe("part one\n[non-text content]");
    expect(calls[0].req.tools).toEqual([{ name: "f", description: "d", parameters: { type: "object", properties: {} } }]);
  });

  it("logs one complete entry with actual tokens and cost for a routed non-streaming request", async () => {
    const res = await post({ model: "auto:billing", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "complete", model: "p/small", tier: "fast", fell_back: false, input_tokens: 7, output_tokens: 3, model_latency_ms: 12, tag: "billing", jev_latency_ms: 150 });
    // p/small has no price in the test config, so cost is null rather than a guess; the estimate from the decision is kept.
    expect(lines[0].cost_usd).toBeNull(); expect(lines[0].est_cost_usd).toBe(0.00001);
    expect(JSON.stringify(lines[0])).not.toContain("small says hi");
  });
  it("logs the fallback model with fell_back true when the first candidate fails", async () => {
    failSmallWith = new ProviderError("p", 503, "down");
    const res = await post({ model: "auto", messages: [{ role: "user", content: "x" }] });
    failSmallWith = null;
    expect(res.status).toBe(200);
    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "complete", model: "q/medium", tier: "mid", fell_back: true });
  });
  it("logs one route-only entry for a routed streaming request", async () => {
    const res = await post({ model: "auto", stream: true, messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(200); await res.text();
    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "route", model: "p/small", tier: "fast", cost_usd: null, input_tokens: null, output_tokens: null });
  });
  it("logs a route-only entry when every candidate fails, so the decision is not lost", async () => {
    failSmallWith = new ProviderError("p", 400, "bad param");
    const res = await post({ model: "auto", messages: [{ role: "user", content: "x" }] });
    failSmallWith = null;
    expect(res.status).toBe(400);
    const lines = readLogLines();
    expect(lines).toHaveLength(1); expect(lines[0].kind).toBe("route");
  });
  it("writes nothing to the log for an explicit model id", async () => {
    const res = await post({ model: "q/medium", messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(200);
    expect(readLogLines()).toHaveLength(0);
  });
});
