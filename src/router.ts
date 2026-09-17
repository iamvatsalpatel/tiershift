/** createRouter(): Jev signals → policy → model selection with budget, context, and capability checks. */
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { loadConfig, splitModel } from "./config.js";
import { applyPolicy, estimateOutputTokens } from "./policy.js";
import { askJev, codeSignals } from "./signals.js";
import { buildProviders } from "./providers/index.js";
import type { Provider } from "./providers/index.js";
import { ProviderError } from "./providers/index.js";
import type { Attempt, CompleteInput, CompleteResult, Config, Decision, ModelMeta, RouteInput } from "./types.js";

export interface RouterOptions {
  /** Path to tiershift.yaml. Defaults to ./tiershift.yaml, then the bundled default. */
  config?: string | Config;
  /** Override env lookup, mainly for tests. */
  env?: Record<string, string | undefined>;
  typesafeApiKey?: string;
}

export interface Router {
  /** Decide only. Returns the model to use, a fallback, every signal, and the reasons. */
  route(input: RouteInput): Promise<Decision>;
  /** Decide, call the model, and fall back one tier up on failure. */
  complete(input: CompleteInput): Promise<CompleteResult>;
  config: Config;
  providers: Record<string, Provider>;
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
  const client = new TypeSafeClient({ apiKey: opts.typesafeApiKey ?? env.TYPESAFE_API_KEY, defaultModel: config.jev?.model ?? "jev-latest" });
  const order = Object.keys(config.tiers);
  const providers = buildProviders(config, env);

  const available = () => Object.fromEntries(order.map((t) => [t, config.tiers[t].filter((id) => hasKey(config, splitModel(id).provider, env))]));

  async function route(input: RouteInput): Promise<Decision> {
    const code = codeSignals(input);
    const jev = await askJev(client, input, config.jev?.model, config.jev?.timeout_ms);
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
    if (config.fallback !== "none") {
      for (let fi = ti + 1; fi < order.length && !fallback; fi++) {
        fallback = pickInTier(config, order[fi], code.est_input_tokens, outTok, code.has_tools, undefined, env, [])?.id ?? null;
      }
    }

    const decidingConf = Math.min(jev.signals.difficulty_confidence, jev.signals.stakes_confidence);
    return {
      model: pick.id,
      provider: splitModel(pick.id).provider,
      tier: order[ti],
      tier_index: ti,
      requested_tier: policy.tier,
      degraded,
      fallback,
      signals: jev.signals,
      code_signals: code,
      confidence: Number(decidingConf.toFixed(3)),
      reason,
      est_cost_usd: pick.cost,
      est_output_tokens: outTok,
      jev_latency_ms: jev.latency_ms,
      jev_input_tokens: jev.input_tokens,
    };
  }

  function actualCost(meta: ModelMeta | undefined, usage: { inputTokens: number; outputTokens: number }): number | null {
    if (!meta?.price) return null;
    return (usage.inputTokens * meta.price.input + usage.outputTokens * meta.price.output) / 1_000_000;
  }

  async function complete(input: CompleteInput): Promise<CompleteResult> {
    const decision = await route(input);
    const candidates = [decision.model, decision.fallback].filter((m): m is string => Boolean(m));
    const attempts: Attempt[] = [];
    for (const id of candidates) {
      const { provider: pname, model } = splitModel(id);
      const provider = providers[pname];
      const t0 = performance.now();
      if (!provider) { attempts.push({ model: id, ok: false, latency_ms: 0, error: `provider "${pname}" has no key` }); continue; }
      try {
        const r = await provider.complete({
          model,
          messages: input.messages,
          tools: input.tools,
          maxTokens: input.maxTokens ?? config.defaults?.max_tokens ?? 4096,
          temperature: input.temperature ?? config.defaults?.temperature,
          params: config.models?.[id]?.params,
        }, input.signal);
        attempts.push({ model: id, ok: true, latency_ms: r.latencyMs });
        return {
          decision, model: id, served_model: r.servedModel, fell_back: id !== decision.model, attempts,
          text: r.text, tool_calls: r.toolCalls, finish_reason: r.finishReason,
          usage: { input_tokens: r.usage.inputTokens, output_tokens: r.usage.outputTokens },
          cost_usd: actualCost(config.models?.[id], r.usage), latency_ms: r.latencyMs, raw: r.raw,
        };
      } catch (e) {
        if (input.signal?.aborted) throw e;
        const pe = e instanceof ProviderError ? e : null;
        attempts.push({ model: id, ok: false, latency_ms: Math.round(performance.now() - t0), error: e instanceof Error ? e.message : String(e), status: pe?.status ?? null });
      }
    }
    throw new Error(`tiershift: every candidate failed. ${attempts.map((a) => `${a.model}: ${a.error}`).join(" | ")}`);
  }

  return { route, complete, config, providers, available };
}
