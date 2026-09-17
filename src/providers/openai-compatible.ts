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

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const url = `${this.opts.baseURL.replace(/\/$/, "")}/chat/completions`;
    const tokenParam = this.resolveTokenParam();
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content, ...(m.name ? { name: m.name } : {}) })),
      ...(req.maxTokens ? { [tokenParam]: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters ?? { type: "object", properties: {} } } })) } : {}),
      ...(req.params ?? {}),
    };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;

    const t0 = performance.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 120_000);
    signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      throw new ProviderError(this.name, null, e instanceof Error ? e.message : String(e));
    }
    clearTimeout(timer);
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

  private resolveTokenParam(): "max_tokens" | "max_completion_tokens" {
    if (this.opts.tokenParam && this.opts.tokenParam !== "auto") return this.opts.tokenParam;
    // Verified 2026-09-17: api.openai.com rejects max_tokens on gpt-5.x; Ollama accepts both but is 60x slower on max_completion_tokens.
    return /api\.openai\.com/.test(this.opts.baseURL) ? "max_completion_tokens" : "max_tokens";
  }
}
