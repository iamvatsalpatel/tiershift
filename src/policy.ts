/** Evaluate YAML rules and overrides against signals. Pure functions. No I/O. */
import type { CodeSignals, Config, Signals } from "./types.js";

type Vars = Record<string, number | string | boolean | null>;

/** Flatten Jev signals, code signals, and the current tier into one lookup table for conditions. */
export function buildVars(signals: Signals, code: CodeSignals, tier: string | null): Vars {
  return { ...signals, ...code, tier };
}

const COND = /^\s*([a-z_]+)\s*(>=|<=|==|!=|>|<)\s*("?[\w.:-]+"?)\s*$/i;

/** Evaluate one atomic condition like `difficulty < 0.5` or `tier == local` or `has_tools`. */
function evalAtom(atom: string, vars: Vars): boolean {
  const bare = atom.trim();
  if (/^[a-z_]+$/i.test(bare)) {
    if (!(bare in vars)) throw new Error(`Unknown variable in condition: ${bare}`);
    return Boolean(vars[bare]);
  }
  const m = COND.exec(bare);
  if (!m) throw new Error(`Cannot parse condition: "${atom}"`);
  const [, name, op, rawRhs] = m;
  if (!(name in vars)) throw new Error(`Unknown variable in condition: ${name}`);
  const lhs = vars[name];
  const rhsStr = rawRhs.replace(/^"|"$/g, "");
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
    default: throw new Error(`Unknown operator ${op}`);
  }
}

/** Conditions support `and` / `or` with `and` binding tighter. No parentheses. */
export function evalCondition(expr: string, vars: Vars): boolean {
  return expr.split(/\s+or\s+/i).some((clause) => clause.split(/\s+and\s+/i).every((atom) => evalAtom(atom, vars)));
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
