"""Evaluate YAML rules and overrides against signals. Pure functions. No I/O. Port of src/policy.ts."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Union

from .types import CodeSignals, Config, Signals

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


def _eval_atom(atom: str, vars: Vars) -> bool:
    bare = atom.strip()
    if _BARE.match(bare):
        if bare not in vars:
            raise ValueError(f"Unknown variable in condition: {bare}")
        return bool(vars[bare])
    m = _COND.match(bare)
    if not m:
        raise ValueError(f'Cannot parse condition: "{atom}"')
    name, op, raw_rhs = m.group(1), m.group(2), m.group(3)
    if name not in vars:
        raise ValueError(f"Unknown variable in condition: {name}")
    lhs = vars[name]
    rhs_str = raw_rhs.strip('"')
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
    raise ValueError(f"Unknown operator {op}")


def _js_string(v: Any) -> str:
    """Match JavaScript String(x) for the values that reach conditions."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def eval_condition(expr: str, vars: Vars) -> bool:
    """Conditions support `and` / `or` with `and` binding tighter. No parentheses."""
    return any(all(_eval_atom(atom, vars) for atom in _AND.split(clause)) for clause in _OR.split(expr))


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
