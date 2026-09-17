/** Anthropic adapter on the official SDK. */
import Anthropic from "@anthropic-ai/sdk";
import type { CompletionRequest, CompletionResult, Provider } from "./types.js";
import { ProviderError } from "./types.js";

export interface AnthropicOptions { name: string; apiKey?: string; baseURL?: string; timeoutMs?: number }

export class AnthropicProvider implements Provider {
  readonly name: string;
  private client: Anthropic;
  constructor(opts: AnthropicOptions) {
    this.name = opts.name;
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, timeout: opts.timeoutMs ?? 120_000 });
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const messages: Anthropic.MessageParam[] = req.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    const tools: Anthropic.Tool[] | undefined = req.tools?.length
      ? req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: (t.parameters as Anthropic.Tool.InputSchema) ?? { type: "object", properties: {} } }))
      : undefined;
    const t0 = performance.now();
    try {
      const res = await this.client.messages.create(
        { model: req.model, max_tokens: req.maxTokens ?? 16_000, ...(system ? { system } : {}), messages, ...(tools ? { tools } : {}), ...(req.params ?? {}) } as Anthropic.MessageCreateParamsNonStreaming,
        { signal },
      );
      return {
        text: res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join(""),
        toolCalls: res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input) })),
        finishReason: res.stop_reason ?? "unknown",
        usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
        servedModel: res.model,
        latencyMs: Math.round(performance.now() - t0),
        raw: res,
      };
    } catch (e) {
      if (e instanceof Anthropic.APIError) throw new ProviderError(this.name, e.status ?? null, e.message, e.error);
      throw new ProviderError(this.name, null, e instanceof Error ? e.message : String(e));
    }
  }
}
