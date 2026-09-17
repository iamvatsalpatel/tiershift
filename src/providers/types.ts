/** Minimal provider interface. tiershift decides which model; adapters make the call. */
import type { Message, ToolDef } from "../types.js";

export interface CompletionRequest {
  model: string;
  messages: Message[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  /** Provider-specific fields merged into the request body. From `models.<id>.params` in the config. */
  params?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON string of arguments, as the provider returned it. */
  arguments: string;
}

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
  /** The model id the provider reports it actually served. */
  servedModel: string;
  latencyMs: number;
  raw: unknown;
}

export interface Provider {
  readonly name: string;
  complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult>;
  /**
   * Optional. Start a streaming completion and return the upstream fetch Response so its SSE body can be piped
   * through unchanged. Adapters that cannot stream in the OpenAI wire format leave this undefined.
   */
  streamRaw?(req: CompletionRequest, signal?: AbortSignal): Promise<Response>;
}

export class ProviderError extends Error {
  constructor(public provider: string, public status: number | null, message: string, public body?: unknown) {
    super(`${provider}: ${message}`);
    this.name = "ProviderError";
  }
  /** 408, 409, 429, and 5xx are worth a retry on the fallback model. 4xx validation errors are not. */
  get retryable(): boolean {
    return this.status === null || this.status === 408 || this.status === 409 || this.status === 429 || this.status >= 500;
  }
}
