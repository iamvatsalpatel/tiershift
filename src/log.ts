/** Decision log: one JSON line per route. Signals, tier, model, cost, latency. Never message text. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Decision } from "./types.js";

export interface LogEntry {
  ts: string;
  /** "route" when only a decision was made; "complete" when a model was called. */
  kind: "route" | "complete";
  model: string;
  tier: string;
  requested_tier: string;
  degraded: boolean;
  fell_back: boolean;
  confidence: number;
  signals: Decision["signals"];
  code_signals: Decision["code_signals"];
  reason: string[];
  est_cost_usd: number | null;
  /** Everything billed for the request: failed attempts, gate calls, and the served answer. Null for route-only entries. */
  cost_usd: number | null;
  /** Answer-gate probability for the served answer, when the gate ran. */
  gate_addresses?: number;
  input_tokens: number | null;
  output_tokens: number | null;
  jev_latency_ms: number;
  jev_input_tokens: number;
  model_latency_ms: number | null;
  /** Caller-supplied tag, e.g. an agent name or tenant. */
  tag?: string;
}

export const DEFAULT_LOG = ".tiershift/decisions.jsonl";

export function logEntry(path: string, entry: LogEntry): void {
  const p = resolve(path);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + "\n");
}

export function readLog(path: string): LogEntry[] {
  const p = resolve(path);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as LogEntry);
}

export function fromDecision(d: Decision, extra: Partial<LogEntry> & { kind: LogEntry["kind"] }): LogEntry {
  return {
    ts: new Date().toISOString(),
    model: d.model, tier: d.tier, requested_tier: d.requested_tier, degraded: d.degraded, fell_back: false,
    confidence: d.confidence, signals: d.signals, code_signals: d.code_signals, reason: d.reason,
    est_cost_usd: d.est_cost_usd, cost_usd: null, input_tokens: null, output_tokens: null,
    jev_latency_ms: d.jev_latency_ms, jev_input_tokens: d.jev_input_tokens, model_latency_ms: null,
    ...extra,
  };
}
