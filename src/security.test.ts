/** Secrets never reach the log, the reasons, or error messages. Message text never reaches the log. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRouter } from "./router.js";
import type { JevClient } from "./signals.js";
import type { Provider } from "./providers/index.js";
import { ProviderError } from "./providers/index.js";
import type { Config } from "./types.js";

const SECRET = "sk-test-SECRET123-do-not-leak";
const TS_SECRET = "ts_live_SECRET456";
const PROMPT = "the launch code is 7-7-7-ALPHA";

const config: Config = {
  providers: { cloud: { type: "openai-compatible", base_url: "https://x/v1", api_key_env: "CLOUD_KEY" } },
  tiers: { fast: ["cloud/fast"], flagship: ["cloud/big"] },
  models: { "cloud/fast": { price: { input: 1, output: 1 } }, "cloud/big": { price: { input: 10, output: 10 } } },
  rules: [{ when: "difficulty < 1", tier: "fast" }, { default: "flagship" }],
  jev: { model: "jev-test" },
};
const jev: JevClient = {
  systemOne: (async () => ({ model: "fake", usage: { input_tokens: 1, output_tokens: 1 }, answers: {
    difficulty: { type: "score", score: 0.5, confidence: 0.9, legend: {}, probabilities: {} }, needs_reasoning: { type: "noul", noul: 0 }, stakes: { type: "score", score: 0, confidence: 0.9, legend: {}, probabilities: {} },
    domain: { type: "choice", choice: "general", confidence: 0.9, probabilities: {} }, has_code: { type: "noul", noul: 0 }, ambiguous: { type: "noul", noul: 0 }, output_length: { type: "score", score: 0, confidence: 0.9, legend: {}, probabilities: {} },
    creative: { type: "noul", noul: 0 }, safety_sensitive: { type: "noul", noul: 0 }, trivial_ack: { type: "noul", noul: 0 }, mid_tier_ok: { type: "noul", noul: 0.5 },
  } })) as unknown as JevClient["systemOne"],
};
/** A provider whose error message echoes the key, the way a careless upstream might. The router must not amplify it into the log. */
const leakyProvider: Provider = { name: "cloud", async complete() { throw new ProviderError("cloud", 500, `upstream said: Authorization: Bearer ${SECRET}`); } };
const okProvider: Provider = { name: "cloud", async complete(req) { return { text: `echo: ${req.messages[0].content}`, toolCalls: [], finishReason: "stop", usage: { inputTokens: 5, outputTokens: 5 }, servedModel: req.model, latencyMs: 1, raw: { echoed_prompt: req.messages[0].content } }; } };

describe("security", () => {
  it("route: log and reasons contain neither the API keys nor the prompt", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "ts-sec-")), "d.jsonl");
    const r = createRouter({ config, env: { CLOUD_KEY: SECRET, TYPESAFE_API_KEY: TS_SECRET }, typesafeApiKey: TS_SECRET, __jevClient: jev, __providers: { cloud: okProvider }, log });
    const d = await r.route({ messages: [{ role: "user", content: PROMPT }] });
    const logText = readFileSync(log, "utf8");
    for (const bad of [SECRET, TS_SECRET, PROMPT, "7-7-7-ALPHA"]) { expect(logText).not.toContain(bad); expect(d.reason.join("\n")).not.toContain(bad); }
  });
  it("complete: the log carries usage and cost but never the prompt or the answer", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "ts-sec-")), "d.jsonl");
    const r = createRouter({ config, env: { CLOUD_KEY: SECRET }, __jevClient: jev, __providers: { cloud: okProvider }, log });
    const res = await r.complete({ messages: [{ role: "user", content: PROMPT }] });
    expect(res.text).toContain("7-7-7-ALPHA"); // the caller gets the answer
    const logText = readFileSync(log, "utf8");
    expect(logText).not.toContain("7-7-7-ALPHA"); expect(logText).not.toContain(SECRET);
    expect(JSON.parse(logText.trim())).toMatchObject({ kind: "complete", input_tokens: 5, output_tokens: 5 });
  });
  it("errors: a thrown message never contains the configured key even when the provider echoed it", async () => {
    const r = createRouter({ config: { ...config, fallback: "none" }, env: { CLOUD_KEY: SECRET }, __jevClient: jev, __providers: { cloud: leakyProvider }, log: false });
    let message = "";
    try { await r.complete({ messages: [{ role: "user", content: PROMPT }] }); } catch (e) { message = e instanceof Error ? e.message : String(e); }
    expect(message).toMatch(/every candidate failed/);
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain(PROMPT);
  });
});
