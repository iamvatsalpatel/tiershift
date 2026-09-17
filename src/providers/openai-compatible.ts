/** One adapter for every OpenAI-compatible chat endpoint: OpenAI, DeepSeek, Groq, Together, OpenRouter, Ollama, Gemini. */
import type { CompletionRequest, CompletionResult, Provider } from "./types.js";
import { ProviderError } from "./types.js";

export interface OpenAICompatibleOptions {
  name: string;
  baseURL: string;
  apiKey?: string;
  /** OpenAI reasoning models reject `max_tokens` and need `max_completion_tokens`. Ollama is the reverse. Default "auto". */
  tokenParam?: "max_tokens" | "max_completion_tokens" | "auto";
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class OpenAICompatibleProvider implements Provider {
  readonly name: string;
  constructor(private opts: OpenAICompatibleOptions) { this.name = opts.name; }

  /** Build the JSON body and headers for one chat-completions request. Shared by complete() and streamRaw(). */
  private buildRequest(req: CompletionRequest, stream: boolean): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
    const url = `${this.opts.baseURL.replace(/\/$/, "")}/chat/completions`;
    const tokenParam = this.resolveTokenParam();
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content, ...(m.name ? { name: m.name } : {}) })),
      ...(req.maxTokens ? { [tokenParam]: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters ?? { type: "object", properties: {} } } })) } : {}),
      ...(req.params ?? {}),
      ...(stream ? { stream: true } : {}),
    };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;
    return { url, headers, body };
  }

  /** POST with the per-attempt timeout and caller abort wired in. Network failures become ProviderError. */
  private async post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
    try {
      return await (this.opts.fetch ?? fetch)(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      throw new ProviderError(this.name, null, e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const { url, headers, body } = this.buildRequest(req, false);
    const t0 = performance.now();
    const res = await this.post(url, headers, body, signal, this.opts.timeoutMs ?? 120_000);
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) throw new ProviderError(this.name, res.status, json?.error?.message ?? text.slice(0, 300), json);

    const choice = json.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    return {
      text: typeof msg.content === "string" ? msg.content : "",
      toolCalls: (msg.tool_calls ?? []).map((c: any) => ({ id: c.id, name: c.function?.name, arguments: c.function?.arguments ?? "{}" })),
      finishReason: choice.finish_reason ?? "unknown",
      usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
      servedModel: json.model ?? req.model,
      latencyMs: Math.round(performance.now() - t0),
      raw: json,
    };
  }

  /**
   * Start a streaming chat completion and return the upstream Response untouched, so a caller can pipe
   * `res.body` (server-sent events) straight through. The response headers have arrived; the body has not.
   * A non-2xx status is thrown as ProviderError after reading the error body.
   * The timeout here covers only the time to first byte; the stream itself is bounded by the caller's signal.
   */
  async streamRaw(req: CompletionRequest, signal?: AbortSignal): Promise<Response> {
    const { url, headers, body } = this.buildRequest(req, true);
    const res = await this.post(url, headers, body, signal, this.opts.timeoutMs ?? 120_000);
    if (!res.ok) {
      const text = await res.text();
      let json: any;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      throw new ProviderError(this.name, res.status, json?.error?.message ?? text.slice(0, 300), json);
    }
    return res;
  }

  private resolveTokenParam(): "max_tokens" | "max_completion_tokens" {
    if (this.opts.tokenParam && this.opts.tokenParam !== "auto") return this.opts.tokenParam;
    // Verified 2026-09-17: api.openai.com rejects max_tokens on gpt-5.x; Ollama accepts both but is 60x slower on max_completion_tokens.
    return /api\.openai\.com/.test(this.opts.baseURL) ? "max_completion_tokens" : "max_tokens";
  }
}
