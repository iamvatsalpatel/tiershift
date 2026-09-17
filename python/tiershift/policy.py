"""Evaluate YAML rules and overrides against signals. Pure functions. No I/O. Port of src/policy.ts."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Sequence, Union

from .types import KNOWN_SIGNALS, CodeSignals, Config, Signals

Vars = dict[str, Union[float, int, str, bool, None]]

_COND = re.compile(r'^\s*([a-z_]+)\s*(>=|<=|==|!=|>|<)\s*("?[\w.:-]+"?)\s*$', re.IGNORECASE)
_BARE = re.compile(r"^[a-z_]+$", re.IGNORECASE)
_OR = re.compile(r"\s+or\s+", re.IGNORECASE)
_AND = re.compile(r"\s+and\s+", re.IGNORECASE)


def build_vars(signals: Signals, code: CodeSignals, tier: str | None) -> Vars:
    """Flatten Jev signals, code signals, and the current tier into one lookup table for conditions."""
    return {**signals.to_dict(), **code.to_dict(), "tier": tier}


def _to_number(s: str) -> float | None:
    try:
        return float(s)
    except ValueError:
        return None


@dataclass
class ParsedAtom:
    name: str
    op: str | None
    rhs: str | None


def edit_distance(a: str, b: str) -> int:
    """Levenshtein distance, for did-you-mean hints."""
    dp = [[i] + [0] * len(b) for i in range(len(a) + 1)]
    for j in range(1, len(b) + 1):
        dp[0][j] = j
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (0 if a[i - 1] == b[j - 1] else 1))
    return dp[len(a)][len(b)]


def suggest(name: str, candidates: Sequence[str] = KNOWN_SIGNALS) -> str:
    """' (did you mean "x"?)' when a known name is within edit distance 3, else ''."""
    best: str | None = None
    best_d = 4
    for c in candidates:
        d = edit_distance(name.lower(), c.lower())
        if d < best_d:
            best_d, best = d, c
    return f' (did you mean "{best}"?)' if best else ""


def parse_atom(atom: str) -> ParsedAtom:
    """Parse one atom without evaluating it. Raises on syntax errors and unknown signal names."""
    bare = atom.strip()
    if not bare:
        raise ValueError("empty condition")
    if _BARE.match(bare):
        if bare not in KNOWN_SIGNALS:
            raise ValueError(f'unknown signal "{bare}"{suggest(bare)}')
        return ParsedAtom(bare, None, None)
    m = _COND.match(bare)
    if not m:
        raise ValueError(f'cannot parse "{bare}" (expected: signal, or signal <op> value, with <op> one of > < >= <= == !=)')
    name, op, rhs = m.group(1), m.group(2), m.group(3)
    if name not in KNOWN_SIGNALS:
        raise ValueError(f'unknown signal "{name}"{suggest(name)}')
    return ParsedAtom(name, op, rhs)


def split_condition(expr: str) -> list[list[str]]:
    """Split a condition into its `or`-clauses of `and`-atoms."""
    return [_AND.split(clause) for clause in _OR.split(expr)]


def parse_condition(expr: Any) -> list[list[ParsedAtom]]:
    """Parse a whole condition. Raises with the offending atom quoted."""
    if not isinstance(expr, str) or not expr.strip():
        raise ValueError("empty condition")
    return [[parse_atom(a) for a in clause] for clause in split_condition(expr)]


def _eval_atom(atom: str, vars: Vars) -> bool:
    parsed = parse_atom(atom)
    name, op, raw_rhs = parsed.name, parsed.op, parsed.rhs
    if name not in vars:
        raise ValueError(f'unknown signal "{name}"')
    lhs = vars[name]
    if op is None:
        return bool(lhs)
    rhs_str = (raw_rhs or "").strip('"')
    rhs_num = _to_number(rhs_str)
    numeric = rhs_num is not None and isinstance(lhs, (int, float)) and not isinstance(lhs, bool)
    if numeric:
        left: Any = float(lhs)  # type: ignore[arg-type]
        right: Any = rhs_num
    else:
        left = _js_string(lhs)
        right = rhs_str
    if op == ">":
        return left > right
    if op == "<":
        return left < right
    if op == ">=":
        return left >= right
    if op == "<=":
        return left <= right
    if op == "==":
        return left == right
    if op == "!=":
        return left != right
    raise ValueError(f"unknown operator {op}")


def _js_string(v: Any) -> str:
    """Match JavaScript String(x) for the values that reach conditions."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def eval_condition(expr: str, vars: Vars) -> bool:
    """Conditions support `and` / `or` with `and` binding tighter. No parentheses."""
    return any(all(_eval_atom(atom, vars) for atom in clause) for clause in split_condition(expr))


@dataclass
class PolicyResult:
    tier: str
    tier_index: int
    reason: list[str]


def apply_policy(config: Config, signals: Signals, code: CodeSignals) -> PolicyResult:
    """Apply rules (first match wins) then overrides (all apply, in order)."""
    order = list(config["tiers"].keys())
    if not order:
        raise ValueError("Config has no tiers")

    def idx(t: str) -> int:
        if t not in order:
            raise ValueError(f'Rule references unknown tier "{t}". Tiers: {", ".join(order)}')
        return order.index(t)

    reason: list[str] = []
    vars = build_vars(signals, code, None)

    tier: str | None = None
    for rule in config["rules"]:
        if rule.get("default"):
            tier = rule["default"]
            reason.append(f"default → {tier}")
            break
        if rule.get("when") and rule.get("tier") and eval_condition(rule["when"], vars):
            tier = rule["tier"]
            reason.append(f'rule "{rule["when"]}" → {tier}')
            break
    if tier is None:
        tier = order[-1]
        reason.append(f"no rule matched → {tier}")

    ti = idx(tier)
    for ov in config.get("overrides") or []:
        vars = build_vars(signals, code, order[ti])
        if not eval_condition(ov["when"], vars):
            continue
        if ov.get("at_least"):
            floor = idx(ov["at_least"])
            if floor > ti:
                ti = floor
                reason.append(f'override "{ov["when"]}" → at_least {ov["at_least"]}')
        if ov.get("at_most"):
            ceiling = idx(ov["at_most"])
            if ceiling < ti:
                ti = ceiling
                reason.append(f'override "{ov["when"]}" → at_most {ov["at_most"]}')
        if ov.get("up"):
            nxt = min(len(order) - 1, ti + int(ov["up"]))
            if nxt > ti:
                ti = nxt
                reason.append(f'override "{ov["when"]}" → up {ov["up"]} → {order[ti]}')
    return PolicyResult(tier=order[ti], tier_index=ti, reason=reason)


def estimate_output_tokens(output_length: float) -> int:
    """Map the output_length score bucket to a token estimate. Jev gives the bucket. Code gives the number."""
    if output_length < 0.5:
        return 50
    if output_length < 1.5:
        return 400
    return 2000
