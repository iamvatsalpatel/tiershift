/**
 * OpenAI-compatible chat-completions proxy. Any client in any language sets `baseURL` to this server and
 * `model: "auto"`, and tiershift picks the model per request. Plain node:http, no dependencies.
 *
 * Security: there is no authentication on this server. It binds to 127.0.0.1 by default so only processes on
 * the same machine can reach it. Bind to another host only behind your own auth or network boundary.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { splitModel } from "./config.js";
import type { Router } from "./router.js";
import type { Decision, Message, ToolDef } from "./types.js";
import { ProviderError } from "./providers/types.js";
import type { CompletionRequest, CompletionResult, Provider } from "./providers/types.js";
import { fromDecision, logEntry } from "./log.js";
import type { ModelMeta } from "./types.js";

export interface ProxyOptions {
  router: Pick<Router, "route" | "providers" | "config" | "available" | "logPath">;
  host?: string;
  port?: number;
  /** Max request body in bytes. Default 8 MB. */
  maxBodyBytes?: number;
  /** Env used to find keys to redact from error bodies. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export interface ProxyHandle {
  server: Server;
  url: string;
  close(): Promise<void>;
}

/** Decision headers. Never message text, never keys. */
export const DECISION_HEADERS = ["x-tiershift-model", "x-tiershift-tier", "x-tiershift-fallback", "x-tiershift-confidence", "x-tiershift-jev-ms", "x-tiershift-reason"] as const;

interface OpenAIMessage { role: string; content: unknown; name?: string; tool_calls?: unknown }
interface OpenAITool { type?: string; function?: { name: string; description?: string; parameters?: unknown } }
interface ChatBody {
  model?: string;
  messages?: OpenAIMessage[];
  tools?: OpenAITool[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  stream?: boolean;
  /** Anything else is forwarded to the provider untouched. */
  [k: string]: unknown;
}

class HttpError extends Error {
  constructor(public status: number, message: string, public type = "invalid_request_error", public code: string | null = null) { super(message); }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string, type = "invalid_request_error", code: string | null = null, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error: { message, type, code, param: null } }, headers);
}

async function readBody(req: IncomingMessage, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, `request body exceeds ${max} bytes`, "invalid_request_error", "body_too_large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** OpenAI content may be a string or an array of parts. Keep text parts; drop the rest with a marker. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "[non-text content]")).join("\n");
  if (content == null) return "";
  return String(content);
}

function toMessages(raw: OpenAIMessage[] | undefined): Message[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new HttpError(400, "`messages` must be a non-empty array");
  return raw.map((m, i) => {
    const role = m.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") throw new HttpError(400, `messages[${i}].role must be system, user, assistant, or tool`);
    // Assistant tool-call turns often have null content; keep the turn so the conversation stays valid.
    const content = contentToText(m.content) || (m.tool_calls ? "[tool calls]" : "");
    return { role, content, ...(m.name ? { name: m.name } : {}) };
  });
}

function toTools(raw: OpenAITool[] | undefined): ToolDef[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.filter((t) => t.function?.name).map((t) => ({ name: t.function!.name, description: t.function!.description, parameters: t.function!.parameters }));
}

function decisionHeaders(d: Decision | null, served: string): Record<string, string> {
  if (!d) return { "x-tiershift-model": served, "x-tiershift-tier": "explicit", "x-tiershift-fallback": "none", "x-tiershift-confidence": "", "x-tiershift-jev-ms": "0", "x-tiershift-reason": "explicit model id; routing bypassed" };
  return {
    "x-tiershift-model": served,
    "x-tiershift-tier": d.tier,
    "x-tiershift-fallback": d.fallback ?? "none",
    "x-tiershift-confidence": d.confidence.toFixed(3),
    "x-tiershift-jev-ms": String(d.jev_latency_ms),
    // Reason lines are policy text like `rule "difficulty < 0.5" → fast`. Header values must be Latin-1, so replace the arrow.
    "x-tiershift-reason": d.reason.join(" | ").replace(/→/g, "->").replace(/[^\x20-\x7e]/g, "?").slice(0, 2000),
  };
}

/** Build an OpenAI chat-completions response object from a provider result. */
export function toOpenAIResponse(r: CompletionResult, servedId: string): Record<string, unknown> {
  const hasTools = r.toolCalls.length > 0;
  return {
    id: `chatcmpl-ts-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: servedId,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: hasTools && !r.text ? null : r.text,
        ...(hasTools ? { tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) } : {}),
      },
      finish_reason: r.finishReason === "unknown" ? (hasTools ? "tool_calls" : "stop") : r.finishReason,
      logprobs: null,
    }],
    usage: { prompt_tokens: r.usage.inputTokens, completion_tokens: r.usage.outputTokens, total_tokens: r.usage.inputTokens + r.usage.outputTokens },
  };
}

/** `auto`, `auto:<tag>`, or missing → route. Anything else must be a configured `provider/model` id. */
function parseModelField(model: string | undefined, allModels: Set<string>): { mode: "auto"; tag?: string } | { mode: "explicit"; id: string } {
  if (!model || model === "auto") return { mode: "auto" };
  if (model.startsWith("auto:")) return { mode: "auto", tag: model.slice(5) || undefined };
  if (allModels.has(model)) return { mode: "explicit", id: model };
  throw new HttpError(404, `model "${model}" is not configured. Use "auto", "auto:<tag>", or one of: ${[...allModels].join(", ")}`, "invalid_request_error", "model_not_found");
}

/** Fields the client sent that we forward to the provider verbatim (minus the ones we handle ourselves). */
function passthroughParams(body: ChatBody): Record<string, unknown> {
  const drop = new Set(["model", "messages", "tools", "max_tokens", "max_completion_tokens", "temperature", "stream", "stream_options", "user", "n"]);
  return Object.fromEntries(Object.entries(body).filter(([k]) => !drop.has(k)));
}

export function createProxy(opts: ProxyOptions): Server {
  const { router } = opts;
  // Provider errors sometimes echo request headers. Never let a configured key reach a client-visible error body.
  const env = opts.env ?? process.env;
  const secrets = [env.TYPESAFE_API_KEY, ...Object.values(router.config.providers).map((pc) => (pc.api_key_env ? env[pc.api_key_env] : undefined))]
    .filter((s): s is string => typeof s === "string" && s.length >= 8);
  const redact = (text: string) => secrets.reduce((t, s) => t.split(s).join("[redacted]"), text);
  const maxBody = opts.maxBodyBytes ?? 8 * 1024 * 1024;
  const allModels = new Set(Object.values(router.config.tiers).flat());
  const order = Object.keys(router.config.tiers);
  const tierOf = (id: string) => order.find((t) => router.config.tiers[t].includes(id)) ?? "explicit";

  function providerFor(id: string): Provider {
    const { provider } = splitModel(id);
    const p = router.providers[provider];
    if (!p) throw new HttpError(503, `provider "${provider}" for model "${id}" has no API key configured`, "server_error", "provider_unavailable");
    return p;
  }

  /** Same formula as router.complete(): actual usage times the per-model price from prices.yaml. */
  function actualCost(meta: ModelMeta | undefined, usage: { inputTokens: number; outputTokens: number }): number | null {
    if (!meta?.price) return null;
    return (usage.inputTokens * meta.price.input + usage.outputTokens * meta.price.output) / 1_000_000;
  }

  /** Logging never breaks a response. Same rule as the router. */
  function writeLog(entry: Parameters<typeof logEntry>[1]): void {
    if (!router.logPath) return;
    try { logEntry(router.logPath, entry); } catch { /* never let logging affect the response */ }
  }

  function completionRequest(id: string, messages: Message[], tools: ToolDef[] | undefined, body: ChatBody, decision: Decision | null): CompletionRequest {
    let maxTokens = body.max_completion_tokens ?? body.max_tokens ?? router.config.defaults?.max_tokens ?? 4096;
    // Same floor as router.complete(): reasoning models spend output tokens thinking first; a small budget returns an empty answer at full price.
    const minOut = router.config.defaults?.min_output_tokens ?? 1024;
    if (router.config.models?.[id]?.caps?.includes("reasoning") && maxTokens < minOut) {
      decision?.reason.push(`raised max_tokens to ${minOut} for reasoning model ${id}`);
      maxTokens = minOut;
    }
    return {
      model: splitModel(id).model,
      messages,
      tools,
      maxTokens,
      temperature: body.temperature ?? router.config.defaults?.temperature,
      // Precedence: the operator's per-model YAML `params` win over the same fields sent by the client.
      // The operator knows provider quirks the client does not, e.g. gpt-5.6-luna needs reasoning_effort none for tools.
      params: { ...passthroughParams(body), ...(router.config.models?.[id]?.params ?? {}) },
    };
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: ChatBody;
    try { body = JSON.parse(await readBody(req, maxBody)) as ChatBody; }
    catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, "request body is not valid JSON", "invalid_request_error", "invalid_json"); }
    if (!body || typeof body !== "object") throw new HttpError(400, "request body must be a JSON object");

    const messages = toMessages(body.messages);
    const tools = toTools(body.tools);
    const target = parseModelField(body.model, allModels);
    const abort = new AbortController();
    req.on("close", () => { if (!res.writableEnded) abort.abort(); });

    // Decide. Explicit ids bypass routing and cost no Jev call.
    let decision: Decision | null = null;
    let candidates: string[];
    if (target.mode === "auto") {
      // Suppress the router's route-only entry: the proxy writes the log line itself once it knows the outcome.
      decision = await router.route({ messages, tools, tag: target.tag, __noLog: true });
      candidates = [decision.model, decision.fallback].filter((m): m is string => Boolean(m));
    } else {
      candidates = [target.id];
    }

    if (body.stream) {
      // Streaming: pipe the upstream SSE body through unchanged. Fallback applies only before the first byte
      // (a provider error on connect). Once bytes flow, a mid-stream failure ends the stream; the client sees a cut.
      // Token usage is not available when piping SSE through, so the log gets a route-only entry with the estimate.
      if (decision) writeLog(fromDecision(decision, { kind: "route", tag: target.mode === "auto" ? target.tag : undefined }));
      let lastErr: unknown = null;
      for (const id of candidates) {
        const provider = providerFor(id);
        if (!provider.streamRaw) {
          throw new HttpError(400, `streaming through the proxy is supported for openai-compatible providers only; "${splitModel(id).provider}" is not one. Send stream: false, or route to an openai-compatible tier.`, "invalid_request_error", "stream_unsupported");
        }
        try {
          const upstream = await provider.streamRaw(completionRequest(id, messages, tools, body, decision), abort.signal);
          if (!upstream.body) throw new ProviderError(provider.name, null, "empty stream body");
          res.writeHead(200, {
            "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
            ...decisionHeaders(decision, id),
            ...(decision && id !== decision.model ? { "x-tiershift-fell-back": "true" } : {}),
          });
          res.flushHeaders();
          await new Promise<void>((resolve, reject) => {
            const node = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
            node.on("error", reject);
            res.on("close", resolve);
            node.pipe(res).on("finish", resolve);
          });
          return;
        } catch (e) {
          if (res.headersSent) { res.end(); return; }
          lastErr = e;
          const pe = e instanceof ProviderError ? e : null;
          if (pe && !pe.retryable) throw e; // a 4xx from the provider: fallback will not help
        }
      }
      throw lastErr ?? new HttpError(502, "no candidate model could start a stream", "server_error", "upstream_failed");
    }

    // Non-streaming: try the chosen model, then the fallback, same rule as router.complete().
    const tag = target.mode === "auto" ? target.tag : undefined;
    let lastErr: unknown = null;
    for (const id of candidates) {
      const provider = providerFor(id);
      try {
        const r = await provider.complete(completionRequest(id, messages, tools, body, decision), abort.signal);
        // Same rule as router.complete(): an empty answer that hit the length cap is a failure; try the fallback.
        if (!r.text.trim() && r.toolCalls.length === 0 && r.finishReason === "length") {
          throw new ProviderError(provider.name, null, `empty_answer:length (output budget consumed before any answer text; ${r.usage.outputTokens} output tokens billed)`);
        }
        // Mirror router.complete(): one "complete" entry with actual tokens, cost, and model latency.
        if (decision) writeLog(fromDecision(decision, { kind: "complete", model: id, tier: tierOf(id), fell_back: id !== decision.model, cost_usd: actualCost(router.config.models?.[id], r.usage), input_tokens: r.usage.inputTokens, output_tokens: r.usage.outputTokens, model_latency_ms: r.latencyMs, tag }));
        sendJson(res, 200, toOpenAIResponse(r, id), {
          ...decisionHeaders(decision, id),
          ...(decision && id !== decision.model ? { "x-tiershift-fell-back": "true" } : {}),
          "x-tiershift-served-model": r.servedModel,
          "x-tiershift-model-ms": String(r.latencyMs),
        });
        return;
      } catch (e) {
        lastErr = e;
        const pe = e instanceof ProviderError ? e : null;
        if (pe && !pe.retryable) break;
      }
    }
    // Every candidate failed (or a 4xx stopped the loop): keep the decision in the log as a route-only entry.
    if (decision) writeLog(fromDecision(decision, { kind: "route", tag }));
    throw lastErr ?? new HttpError(502, "every candidate model failed", "server_error", "upstream_failed");
  }

  function handleModels(res: ServerResponse): void {
    const now = Math.floor(Date.now() / 1000);
    const av = router.available();
    const data = [
      { id: "auto", object: "model", created: now, owned_by: "tiershift", tier: "routed" },
      ...[...new Set(Object.values(router.config.tiers).flat())].map((id) => ({ id, object: "model", created: now, owned_by: splitModel(id).provider, tier: tierOf(id), available: Object.values(av).flat().includes(id) })),
    ];
    sendJson(res, 200, { object: "list", data });
  }

  return createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const done = (fn: Promise<void>) => fn.catch((e: unknown) => {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HttpError) return sendError(res, e.status, redact(e.message), e.type, e.code);
      if (e instanceof ProviderError) {
        const status = e.status ?? 502;
        return sendError(res, status >= 400 && status < 600 ? status : 502, redact(e.message), status >= 500 || e.status === null ? "server_error" : "invalid_request_error", "upstream_error");
      }
      const msg = e instanceof Error ? e.message : String(e);
      return sendError(res, 500, redact(msg), "server_error", "internal");
    });
    if (req.method === "GET" && url === "/healthz") return sendJson(res, 200, { ok: true });
    if (req.method === "GET" && url === "/v1/models") return handleModels(res);
    if (req.method === "POST" && url === "/v1/chat/completions") return void done(handleChat(req, res));
    sendError(res, 404, `no route for ${req.method} ${url}. Endpoints: POST /v1/chat/completions, GET /v1/models, GET /healthz`, "invalid_request_error", "not_found");
  });
}

/** Start the proxy and resolve once it is listening. */
export function startProxy(opts: ProxyOptions): Promise<ProxyHandle> {
  const host = opts.host ?? "127.0.0.1";
  const server = createProxy(opts);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 4141, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port ?? 4141;
      resolve({ server, url: `http://${host}:${port}`, close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))) });
    });
  });
}
