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
  price?: { input: number; output: number };
  context?: number;
  caps?: string[];
}

export interface ProviderConfig {
  type: "openai-compatible" | "anthropic";
  base_url?: string;
  api_key_env?: string;
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
