import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { ProviderError } from "./types.js";

function fakeFetch(status: number, body: unknown, capture: { url?: string; body?: any; headers?: any }) {
  return (async (url: any, init: any) => {
    capture.url = String(url); capture.body = JSON.parse(init.body); capture.headers = init.headers;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const ok = { model: "served-1", choices: [{ finish_reason: "stop", message: { content: "hi", tool_calls: [{ id: "c1", function: { name: "f", arguments: "{\"a\":1}" } }] } }], usage: { prompt_tokens: 5, completion_tokens: 2 } };

describe("OpenAICompatibleProvider", () => {
  it("uses max_completion_tokens on api.openai.com and max_tokens elsewhere", async () => {
    const a: any = {}, b: any = {};
    await new OpenAICompatibleProvider({ name: "openai", baseURL: "https://api.openai.com/v1", apiKey: "k", fetch: fakeFetch(200, ok, a) }).complete({ model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 9 });
    await new OpenAICompatibleProvider({ name: "ollama", baseURL: "http://localhost:11434/v1", fetch: fakeFetch(200, ok, b) }).complete({ model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 9 });
    expect(a.body.max_completion_tokens).toBe(9); expect(a.body.max_tokens).toBeUndefined();
    expect(b.body.max_tokens).toBe(9); expect(b.body.max_completion_tokens).toBeUndefined();
    expect(a.headers.Authorization).toBe("Bearer k"); expect(b.headers.Authorization).toBeUndefined();
  });
  it("merges params, maps tools, and parses the result", async () => {
    const cap: any = {};
    const r = await new OpenAICompatibleProvider({ name: "ds", baseURL: "https://api.deepseek.com", apiKey: "k", fetch: fakeFetch(200, ok, cap) })
      .complete({ model: "m", messages: [{ role: "user", content: "x" }], tools: [{ name: "f", description: "d" }], params: { thinking: { type: "disabled" } } });
    expect(cap.url).toBe("https://api.deepseek.com/chat/completions");
    expect(cap.body.thinking).toEqual({ type: "disabled" });
    expect(cap.body.tools[0].function.name).toBe("f");
    expect(r.text).toBe("hi"); expect(r.toolCalls[0]).toEqual({ id: "c1", name: "f", arguments: "{\"a\":1}" });
    expect(r.servedModel).toBe("served-1"); expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });
  it("throws ProviderError with status and retryable flag", async () => {
    const p = new OpenAICompatibleProvider({ name: "x", baseURL: "https://h", apiKey: "k", fetch: fakeFetch(429, { error: { message: "slow down" } }, {}) });
    await expect(p.complete({ model: "m", messages: [] })).rejects.toMatchObject({ name: "ProviderError", status: 429, retryable: true });
    const q = new OpenAICompatibleProvider({ name: "x", baseURL: "https://h", apiKey: "k", fetch: fakeFetch(400, { error: { message: "bad" } }, {}) });
    await expect(q.complete({ model: "m", messages: [] })).rejects.toMatchObject({ status: 400, retryable: false });
    expect(new ProviderError("x", 503, "down").retryable).toBe(true);
  });
});
