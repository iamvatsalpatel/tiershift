/** Public types for tiershift. */

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
  name?: string;
}

export interface ToolDef {
  name: string;
  description?: string;
  parameters?: unknown;
}

/** What the caller knows about the current agent step. All fields optional. */
export interface RouteInput {
  messages: Message[];
  tools?: ToolDef[];
  /** Agent step type, if the caller tracks one. Free text, e.g. "plan", "act", "summarize". */
  step?: string;
  /** How many times this step already failed. Each retry moves one tier up. */
  retries?: number;
  /** Per-call override of the max cost budget in USD. */
  maxCost?: number;
  /** Free-text tag written to the decision log, e.g. an agent or tenant name. */
  tag?: string;
  /** @internal Skip the route-only log entry. Set by complete(). */
  __noLog?: boolean;
}

/** Jev signals. Scores are 0-2 expected values. Nouls are 0-1 probabilities. */
export interface Signals {
  difficulty: number;
  difficulty_confidence: number;
  needs_reasoning: number;
  stakes: number;
  stakes_confidence: number;
  domain: string;
  domain_confidence: number;
  has_code: number;
  ambiguous: number;
  output_length: number;
  creative: number;
  safety_sensitive: number;
  trivial_ack: number;
}

/** Free signals computed in code. */
export interface CodeSignals {
  est_input_tokens: number;
  has_tools: boolean;
  tool_count: number;
  step: string | null;
  retries: number;
  turn_count: number;
}

export interface ModelMeta {
  /** USD per 1M tokens. */
  price?: { input: number; output: number };
  /** Context window in tokens. */
  context?: number;
  /** Max output tokens the model can produce. */
  max_output?: number;
  /** Capabilities: tools, json, vision, reasoning. Missing means unknown, and no capability filter runs. */
  caps?: string[];
  /** Provider-specific request fields merged into every call to this model, e.g. `{ thinking: { type: "disabled" } }`. */
  params?: Record<string, unknown>;
  release_date?: string;
}

export interface ProviderConfig {
  type: "openai-compatible" | "anthropic";
  base_url?: string;
  api_key_env?: string;
  /** Provider key on models.dev when it differs from this provider's name. `false` disables sync for this provider. */
  models_dev?: string | false;
}

export interface Rule {
  when?: string;
  tier?: string;
  default?: string;
}

export interface Override {
  when: string;
  at_least?: string;
  up?: number;
}

export interface Config {
  providers: Record<string, ProviderConfig>;
  tiers: Record<string, string[]>;
  rules: Rule[];
  overrides?: Override[];
  models?: Record<string, ModelMeta>;
  budget?: { max_cost_per_call?: number; prefer?: "order" | "cheapest" };
  fallback?: "up" | "none";
  /** Defaults applied to every completion call. */
  defaults?: { max_tokens?: number; temperature?: number };
  /** Decision log. On by default at `.tiershift/decisions.jsonl`. */
  log?: { enabled?: boolean; path?: string };
  /** When no model at or above the chosen tier has a key, use the best available model below. Default true. */
  degrade?: boolean;
  jev?: { model?: string; timeout_ms?: number };
}

export interface Decision {
  model: string;
  provider: string;
  tier: string;
  tier_index: number;
  /** The tier the policy asked for, before key or budget constraints. */
  requested_tier: string;
  /** True when the model came from a lower tier than requested because nothing above had a key. */
  degraded: boolean;
  fallback: string | null;
  signals: Signals;
  code_signals: CodeSignals;
  /** Lowest confidence among the Jev answers that decided the tier. */
  confidence: number;
  /** One line per applied rule or override, in order. */
  reason: string[];
  est_cost_usd: number | null;
  est_output_tokens: number;
  jev_latency_ms: number;
  jev_input_tokens: number;
}

/** Input for `router.complete()`. Same as RouteInput plus call parameters. */
export interface CompleteInput extends RouteInput {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface Attempt {
  model: string;
  ok: boolean;
  latency_ms: number;
  error?: string;
  status?: number | null;
}

export interface CompleteResult {
  decision: Decision;
  /** The model that produced the answer. Differs from decision.model when a fallback ran. */
  model: string;
  served_model: string;
  fell_back: boolean;
  attempts: Attempt[];
  text: string;
  tool_calls: { id: string; name: string; arguments: string }[];
  finish_reason: string;
  usage: { input_tokens: number; output_tokens: number };
  /** Actual cost from reported usage and prices.yaml. Null when the price is unknown. */
  cost_usd: number | null;
  latency_ms: number;
  raw: unknown;
}
