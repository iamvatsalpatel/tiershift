/** Evaluate YAML rules and overrides against signals. Pure functions. No I/O. */
import { KNOWN_SIGNALS } from "./types.js";
import type { CodeSignals, Config, Signals } from "./types.js";

type Vars = Record<string, number | string | boolean | null>;

/** Flatten Jev signals, code signals, and the current tier into one lookup table for conditions. */
export function buildVars(signals: Signals, code: CodeSignals, tier: string | null): Vars {
  return { ...signals, ...code, tier };
}

const COND = /^\s*([a-z_]+)\s*(>=|<=|==|!=|>|<)\s*("?[\w.:-]+"?)\s*$/i;
const BARE = /^[a-z_]+$/i;

export interface ParsedAtom { name: string; op: string | null; rhs: string | null }

/** Parse one atom without evaluating it. Throws on syntax errors and unknown signal names. */
export function parseAtom(atom: string): ParsedAtom {
  const bare = atom.trim();
  if (bare.length === 0) throw new Error(`empty condition`);
  if (BARE.test(bare)) {
    if (!(KNOWN_SIGNALS as readonly string[]).includes(bare)) throw new Error(`unknown signal "${bare}"${suggest(bare)}`);
    return { name: bare, op: null, rhs: null };
  }
  const m = COND.exec(bare);
  if (!m) throw new Error(`cannot parse "${bare}" (expected: signal, or signal <op> value, with <op> one of > < >= <= == !=)`);
  const [, name, op, rhs] = m;
  if (!(KNOWN_SIGNALS as readonly string[]).includes(name)) throw new Error(`unknown signal "${name}"${suggest(name)}`);
  return { name, op, rhs };
}

/** Split a condition into its `or`-clauses of `and`-atoms. */
export function splitCondition(expr: string): string[][] {
  return expr.split(/\s+or\s+/i).map((clause) => clause.split(/\s+and\s+/i));
}

/** Parse a whole condition. Throws with the offending atom quoted. */
export function parseCondition(expr: string): ParsedAtom[][] {
  if (typeof expr !== "string" || expr.trim().length === 0) throw new Error(`empty condition`);
  return splitCondition(expr).map((clause) => clause.map(parseAtom));
}

/** Evaluate one atomic condition like `difficulty < 0.5` or `tier == local` or `has_tools`. */
function evalAtom(atom: string, vars: Vars): boolean {
  const { name, op, rhs } = parseAtom(atom);
  if (!(name in vars)) throw new Error(`unknown signal "${name}"`);
  const lhs = vars[name];
  if (op === null) return Boolean(lhs);
  const rhsStr = (rhs as string).replace(/^"|"$/g, "");
  const rhsNum = Number(rhsStr);
  const numeric = !Number.isNaN(rhsNum) && typeof lhs === "number";
  const l = numeric ? (lhs as number) : String(lhs);
  const r = numeric ? rhsNum : rhsStr;
  switch (op) {
    case ">": return l > r;
    case "<": return l < r;
    case ">=": return l >= r;
    case "<=": return l <= r;
    case "==": return l === r;
    case "!=": return l !== r;
    default: throw new Error(`unknown operator ${op}`);
  }
}

/** Conditions support `and` / `or` with `and` binding tighter. No parentheses. */
export function evalCondition(expr: string, vars: Vars): boolean {
  return splitCondition(expr).some((clause) => clause.every((atom) => evalAtom(atom, vars)));
}

/** Levenshtein distance, for did-you-mean hints. */
export function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** " (did you mean \"x\"?)" when a known name is within edit distance 3, else "". */
export function suggest(name: string, candidates: readonly string[] = KNOWN_SIGNALS): string {
  let best: string | null = null, bestD = 4;
  for (const c of candidates) { const d = editDistance(name.toLowerCase(), c.toLowerCase()); if (d < bestD) { bestD = d; best = c; } }
  return best ? ` (did you mean "${best}"?)` : "";
}

export interface PolicyResult {
  tier: string;
  tier_index: number;
  reason: string[];
}

/** Apply rules (first match wins) then overrides (all apply, in order). */
export function applyPolicy(config: Config, signals: Signals, code: CodeSignals): PolicyResult {
  const order = Object.keys(config.tiers);
  if (order.length === 0) throw new Error("Config has no tiers");
  const idx = (t: string) => {
    const i = order.indexOf(t);
    if (i < 0) throw new Error(`Rule references unknown tier "${t}". Tiers: ${order.join(", ")}`);
    return i;
  };
  const reason: string[] = [];
  let vars = buildVars(signals, code, null);

  let tier: string | null = null;
  for (const rule of config.rules) {
    if (rule.default) { tier = rule.default; reason.push(`default → ${tier}`); break; }
    if (rule.when && rule.tier && evalCondition(rule.when, vars)) {
      tier = rule.tier; reason.push(`rule "${rule.when}" → ${tier}`); break;
    }
  }
  if (tier === null) { tier = order[order.length - 1]; reason.push(`no rule matched → ${tier}`); }

  let ti = idx(tier);
  for (const ov of config.overrides ?? []) {
    vars = buildVars(signals, code, order[ti]);
    if (!evalCondition(ov.when, vars)) continue;
    if (ov.at_least) {
      const floor = idx(ov.at_least);
      if (floor > ti) { ti = floor; reason.push(`override "${ov.when}" → at_least ${ov.at_least}`); }
    }
    if (ov.at_most) {
      const ceiling = idx(ov.at_most);
      if (ceiling < ti) { ti = ceiling; reason.push(`override "${ov.when}" → at_most ${ov.at_most}`); }
    }
    if (ov.up) {
      const next = Math.min(order.length - 1, ti + ov.up);
      if (next > ti) { ti = next; reason.push(`override "${ov.when}" → up ${ov.up} → ${order[ti]}`); }
    }
  }
  return { tier: order[ti], tier_index: ti, reason };
}

/** Map the output_length score bucket to a token estimate. Jev gives the bucket. Code gives the number. */
export function estimateOutputTokens(outputLength: number): number {
  if (outputLength < 0.5) return 50;
  if (outputLength < 1.5) return 400;
  return 2000;
}
