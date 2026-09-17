/** createRouter(): Jev signals → policy → model selection with budget, context, and capability checks. */
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { loadConfig, splitModel } from "./config.js";
import { applyPolicy, estimateOutputTokens } from "./policy.js";
import { askJev, codeSignals } from "./signals.js";
import type { JevClient } from "./signals.js";
import { buildProviders } from "./providers/index.js";
import type { Provider } from "./providers/index.js";
import { ProviderError } from "./providers/index.js";
import { DEFAULT_JEV_MODEL } from "./types.js";
import type { Attempt, CompleteInput, CompleteResult, Config, Decision, ModelMeta, RouteInput } from "./types.js";
import { DEFAULT_LOG, fromDecision, logEntry } from "./log.js";

export interface RouterOptions {
  /** Path to tiershift.yaml. Defaults to ./tiershift.yaml, then the bundled default. */
  config?: string | Config;
  /** Override env lookup, mainly for tests. */
  env?: Record<string, string | undefined>;
  typesafeApiKey?: string;
  /** Decision log path. Defaults to config `log.path`, then `.tiershift/decisions.jsonl`. `false` disables. */
  log?: string | false;
  /** @internal Inject a fake Jev client. Tests only. */
  __jevClient?: JevClient;
  /** @internal Inject fake providers. Tests only. */
  __providers?: Record<string, Provider>;
}

export interface Router {
  /** Decide only. Returns the model to use, a fallback, every signal, and the reasons. */
  route(input: RouteInput): Promise<Decision>;
  /** Decide, call the model, and fall back one tier up on failure. */
  complete(input: CompleteInput): Promise<CompleteResult>;
  config: Config;
  providers: Record<string, Provider>;
  /** Where decisions are written, or null when logging is off. */
  logPath: string | null;
  /** Models whose provider has a usable key, per tier, in preference order. */
  available(): Record<string, string[]>;
}

function hasKey(cfg: Config, providerName: string, env: Record<string, string | undefined>): boolean {
  const p = cfg.providers[providerName];
  if (!p) return false;
  if (!p.api_key_env) return true; // local providers such as Ollama need no key
  return Boolean(env[p.api_key_env]);
}

function estCost(meta: ModelMeta | undefined, inTok: number, outTok: number): number | null {
  if (!meta?.price) return null;
  return (inTok * meta.price.input + outTok * meta.price.output) / 1_000_000;
}

/** Pick the first model in a tier that fits context, capabilities, key, and budget. Returns null when none fits. */
function pickInTier(cfg: Config, tier: string, inTok: number, outTok: number, needTools: boolean, maxCost: number | undefined, env: Record<string, string | undefined>, reason: string[]): { id: string; cost: number | null } | null {
  let candidates = (cfg.tiers[tier] ?? []).filter((id) => hasKey(cfg, splitModel(id).provider, env));
  if (cfg.budget?.prefer === "cheapest") {
    candidates = [...candidates].sort((a, b) => (estCost(cfg.models?.[a], inTok, outTok) ?? Infinity) - (estCost(cfg.models?.[b], inTok, outTok) ?? Infinity));
  }
  for (const id of candidates) {
    const meta = cfg.models?.[id];
    if (meta?.context && inTok * 1.2 > meta.context) { reason.push(`skip ${id}: ${inTok} tokens exceeds context ${meta.context}`); continue; }
    if (needTools && meta?.caps && !meta.caps.includes("tools")) { reason.push(`skip ${id}: no tools capability`); continue; }
    const cost = estCost(meta, inTok, outTok);
    if (maxCost !== undefined && cost !== null && cost > maxCost) { reason.push(`skip ${id}: est $${cost.toFixed(4)} > budget $${maxCost}`); continue; }
    return { id, cost };
  }
  return null;
}

export function createRouter(opts: RouterOptions = {}): Router {
  const env = opts.env ?? process.env;
  const config = typeof opts.config === "object" ? opts.config : loadConfig(opts.config);
  const jevModel = config.jev?.model ?? DEFAULT_JEV_MODEL;
  const client: JevClient = opts.__jevClient ?? new TypeSafeClient({ apiKey: opts.typesafeApiKey ?? env.TYPESAFE_API_KEY, defaultModel: jevModel });
  const order = Object.keys(config.tiers);
  const providers = opts.__providers ?? buildProviders(config, env);
  const logPath = opts.log === false || config.log?.enabled === false ? null : typeof opts.log === "string" ? opts.log : config.log?.path ?? DEFAULT_LOG;
  const write = (e: Parameters<typeof logEntry>[1]) => { if (logPath) try { logEntry(logPath, e); } catch { /* logging never breaks routing */ } };

  const available = () => Object.fromEntries(order.map((t) => [t, config.tiers[t].filter((id) => hasKey(config, splitModel(id).provider, env))]));

  // Every secret this router knows about. Provider errors sometimes echo request headers; never let a key reach a log or an error message.
  const secrets = [opts.typesafeApiKey, env.TYPESAFE_API_KEY, ...Object.values(config.providers).map((p) => (p.api_key_env ? env[p.api_key_env] : undefined))]
    .filter((s): s is string => typeof s === "string" && s.length >= 8);
  const redact = (text: string) => secrets.reduce((t, s) => t.split(s).join("[redacted]"), text);

  async function route(input: RouteInput): Promise<Decision> {
    const code = codeSignals(input);
    const jev = await askJev(client, input, jevModel, config.jev?.timeout_ms);
    const policy = applyPolicy(config, jev.signals, code);
    const outTok = estimateOutputTokens(jev.signals.output_length);
    const maxCost = input.maxCost ?? config.budget?.max_cost_per_call;
    const reason = [...policy.reason];

    // Walk up from the chosen tier until a model fits. Never walk down: a cheaper tier was already judged insufficient.
    let ti = policy.tier_index;
    let pick: { id: string; cost: number | null } | null = null;
    while (ti < order.length && !pick) {
      pick = pickInTier(config, order[ti], code.est_input_tokens, outTok, code.has_tools, maxCost, env, reason);
      if (!pick) { reason.push(`no usable model in tier ${order[ti]}`); ti++; }
    }
    if (ti !== policy.tier_index && pick) reason.push(`walked up to ${order[ti]}`);

    // Last resort: nothing at or above the chosen tier has a key. Degrade to the best available model below,
    // and say so. A laptop with only Ollama must still work. Set `degrade: false` to throw instead.
    let degraded = false;
    if (!pick && config.degrade !== false) {
      for (ti = policy.tier_index - 1; ti >= 0 && !pick; ti--) {
        pick = pickInTier(config, order[ti], code.est_input_tokens, outTok, code.has_tools, maxCost, env, reason);
      }
      if (pick) { ti++; degraded = true; reason.push(`DEGRADED: no usable model in ${policy.tier} or above, using ${order[ti]}`); }
    }
    if (!pick) throw new Error(`No model fits. Check provider keys and budget. Reasons: ${reason.join("; ")}`);

    let fallback: string | null = null;
    let fallbackTier: string | null = null;
    if (config.fallback !== "none") {
      for (let fi = ti + 1; fi < order.length && !fallback; fi++) {
        fallback = pickInTier(config, order[fi], code.est_input_tokens, outTok, code.has_tools, undefined, env, [])?.id ?? null;
        if (fallback) fallbackTier = order[fi];
      }
    }

    const decidingConf = Math.min(jev.signals.difficulty_confidence, jev.signals.stakes_confidence);
    const decision: Decision = {
      model: pick.id,
      provider: splitModel(pick.id).provider,
      tier: order[ti],
      tier_index: ti,
      requested_tier: policy.tier,
      degraded,
      fallback,
      fallback_tier: fallbackTier,
      signals: jev.signals,
      code_signals: code,
      confidence: Number(decidingConf.toFixed(3)),
      reason,
      est_cost_usd: pick.cost,
      est_output_tokens: outTok,
      jev_latency_ms: jev.latency_ms,
      jev_input_tokens: jev.input_tokens,
    };
    if (!input.__noLog) write(fromDecision(decision, { kind: "route", tag: input.tag }));
    return decision;
  }

  function actualCost(meta: ModelMeta | undefined, usage: { inputTokens: number; outputTokens: number }): number | null {
    if (!meta?.price) return null;
    return (usage.inputTokens * meta.price.input + usage.outputTokens * meta.price.output) / 1_000_000;
  }

  async function complete(input: CompleteInput): Promise<CompleteResult> {
    const decision = await route({ ...input, __noLog: true });
    const candidates = [decision.model, decision.fallback].filter((m): m is string => Boolean(m));
    const attempts: Attempt[] = [];
    const minOut = config.defaults?.min_output_tokens ?? 1024;
    for (const id of candidates) {
      const { provider: pname, model } = splitModel(id);
      const provider = providers[pname];
      const t0 = performance.now();
      if (!provider) { attempts.push({ model: id, ok: false, latency_ms: 0, error: `provider "${pname}" has no key`, status: null }); continue; }
      // Reasoning models spend output tokens on thinking first. A small budget returns an empty answer at full price.
      let maxTokens = input.maxTokens ?? config.defaults?.max_tokens ?? 4096;
      if (config.models?.[id]?.caps?.includes("reasoning") && maxTokens < minOut) {
        decision.reason.push(`raised max_tokens to ${minOut} for reasoning model ${id}`);
        maxTokens = minOut;
      }
      try {
        const r = await provider.complete({
          model,
          messages: input.messages,
          tools: input.tools,
          maxTokens,
          temperature: input.temperature ?? config.defaults?.temperature,
          params: config.models?.[id]?.params,
        }, input.signal);
        if (r.text.trim().length === 0 && r.toolCalls.length === 0 && r.finishReason === "length") {
          throw new ProviderError(pname, null, `empty_answer:length (output budget ${maxTokens} consumed before any answer text; ${r.usage.outputTokens} output tokens billed)`);
        }
        attempts.push({ model: id, ok: true, latency_ms: r.latencyMs });
        const cost = actualCost(config.models?.[id], r.usage);
        write(fromDecision(decision, { kind: "complete", model: id, tier: id === decision.model ? decision.tier : decision.fallback_tier ?? decision.tier, fell_back: id !== decision.model, cost_usd: cost, input_tokens: r.usage.inputTokens, output_tokens: r.usage.outputTokens, model_latency_ms: r.latencyMs, tag: input.tag }));
        return {
          decision, model: id, served_model: r.servedModel, fell_back: id !== decision.model, attempts,
          text: r.text, tool_calls: r.toolCalls, finish_reason: r.finishReason,
          usage: { input_tokens: r.usage.inputTokens, output_tokens: r.usage.outputTokens },
          cost_usd: cost, latency_ms: r.latencyMs, raw: r.raw,
        };
      } catch (e) {
        if (input.signal?.aborted) throw e;
        const pe = e instanceof ProviderError ? e : null;
        attempts.push({ model: id, ok: false, latency_ms: Math.round(performance.now() - t0), error: redact(e instanceof Error ? e.message : String(e)), status: pe?.status ?? null });
      }
    }
    throw new Error(`tiershift: every candidate failed. ${attempts.map((a) => `${a.model}: ${a.error}`).join(" | ")}`);
  }

  return { route, complete, config, providers, available, logPath };
}
