/** Shared aggregation helpers for the benchmark report and chart. No network. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Record_ } from "./run.js";

export const here = dirname(fileURLToPath(import.meta.url));
export const ARMS = ["always_flagship", "always_mid", "always_fast", "tiershift"] as const;
export type Arm = (typeof ARMS)[number];
export const CATS = ["ack", "simple", "moderate", "hard"];

export interface Meta { flagship: string; mid?: string; fast: string; local?: string; judge: string; judge2?: string; max_tokens: number; date: string; prompts: number }

export function loadRows(): Record_[] { return readFileSync(join(here, "results.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); }
export function loadMeta(): Meta { return JSON.parse(readFileSync(join(here, "meta.json"), "utf8")); }

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
export const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
export const money = (x: number) => `$${x.toFixed(4)}`;
export const f2 = (x: number) => (Number.isNaN(x) ? "n/a" : x.toFixed(2));

export interface Summary { n: number; total: number; empty: number; errors: number; quality: number; q5: number; cost: number; per1k: number; p50: number; p95: number; outTok: number }

export function summary(rs: Record_[]): Summary {
  const ok = rs.filter((r) => !r.error && r.quality !== null);
  const q = ok.map((r) => r.quality as number);
  const cost = ok.map((r) => r.cost_usd ?? 0).reduce((a, b) => a + b, 0);
  const lat = ok.map((r) => r.latency_ms);
  return { n: ok.length, total: rs.length, empty: rs.filter((r) => r.empty_answer).length, errors: rs.length - ok.length, quality: mean(q), q5: q.filter((x) => x >= 4).length / (q.length || 1), cost, per1k: (cost / (ok.length || 1)) * 1000, p50: pct(lat, 0.5), p95: pct(lat, 0.95), outTok: ok.map((r) => r.output_tokens).reduce((a, b) => a + b, 0) };
}

export function summaries(rows: Record_[]): Record<Arm, Summary> {
  return Object.fromEntries(ARMS.map((a) => [a, summary(rows.filter((r) => r.arm === a))])) as Record<Arm, Summary>;
}
