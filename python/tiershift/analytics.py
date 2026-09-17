"""Aggregations over the decision log for `tiershift report` and `tiershift tune`. Pure functions. Port of src/analytics.ts."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Sequence

from .policy import apply_policy, estimate_output_tokens
from .types import CodeSignals, Config, ModelMeta, Signals

JEV_PRICE = 0.042 / 1e6


def _pct(xs: Sequence[float], p: float) -> float:
    if not xs:
        return 0
    s = sorted(xs)
    return s[min(len(s) - 1, int(p * len(s)))]


def est_cost_for(meta: Optional[ModelMeta], in_tok: int, out_tok: int) -> Optional[float]:
    if not meta or "price" not in meta:
        return None
    price = meta["price"]
    return (in_tok * price["input"] + out_tok * price["output"]) / 1e6


def entry_cost(e: Mapping[str, Any]) -> float:
    """Cost of one entry: actual when a model was called, else the estimate."""
    if e.get("cost_usd") is not None:
        return float(e["cost_usd"])
    if e.get("est_cost_usd") is not None:
        return float(e["est_cost_usd"])
    return 0.0


def model_for_tier(config: Config, tier: str, tiers: Optional[Mapping[str, Sequence[str]]] = None) -> Optional[str]:
    lst = (tiers if tiers is not None else config["tiers"]).get(tier) or []
    return lst[0] if lst else None


@dataclass
class TierStat:
    tier: str
    n: int
    share: float
    cost: float
    est_cost: float
    mean_confidence: float
    p50_jev_ms: float
    estimate_check: Optional[dict[str, float]] = None
    """Present when the tier has entries with actual usage: n, est, actual, ratio (est / actual)."""


@dataclass
class Report:
    n: int
    from_ts: Optional[str]
    to_ts: Optional[str]
    tiers: list[TierStat]
    models: list[dict[str, Any]]
    total_cost: float
    total_est_cost: float
    flagship_est_cost: float
    flagship_model: Optional[str]
    saving_vs_flagship: Optional[float]
    jev: dict[str, float]
    degraded: int
    fell_back: int
    low_confidence: int
    overrides: list[dict[str, Any]] = field(default_factory=list)


def _out_tokens(e: Mapping[str, Any]) -> int:
    return int(e["output_tokens"]) if e.get("output_tokens") is not None else estimate_output_tokens(float(e["signals"]["output_length"]))


def build_report(entries: Sequence[Mapping[str, Any]], config: Config, tiers: Optional[Mapping[str, Sequence[str]]] = None, baseline_model: Optional[str] = None) -> Report:
    order = list(config["tiers"].keys())
    flagship_model = baseline_model or model_for_tier(config, order[-1], tiers)
    n = len(entries)
    tier_stats: list[TierStat] = []
    for tier in order:
        es = [e for e in entries if e.get("tier") == tier]
        stat = TierStat(
            tier=tier, n=len(es), share=len(es) / (n or 1),
            cost=sum(entry_cost(e) for e in es), est_cost=sum(float(e.get("est_cost_usd") or 0) for e in es),
            mean_confidence=(sum(float(e["confidence"]) for e in es) / len(es)) if es else 0,
            p50_jev_ms=_pct([float(e["jev_latency_ms"]) for e in es], 0.5),
        )
        # Where a model was actually called, compare the pre-call estimate with the billed cost so users can see the estimate error.
        both = [e for e in es if e.get("cost_usd") is not None and e.get("est_cost_usd") is not None]
        if both:
            est = sum(float(e["est_cost_usd"]) for e in both)
            actual = sum(float(e["cost_usd"]) for e in both)
            stat.estimate_check = {"n": len(both), "est": est, "actual": actual, "ratio": (est / actual) if actual > 0 else 0}
        tier_stats.append(stat)
    model_ids = sorted({e["model"] for e in entries})
    models = []
    for mid in model_ids:
        es = [e for e in entries if e["model"] == mid]
        models.append({"model": mid, "n": len(es), "cost": sum(entry_cost(e) for e in es), "est_cost": sum(float(e.get("est_cost_usd") or 0) for e in es)})
    meta = (config.get("models") or {}).get(flagship_model) if flagship_model else None
    flagship_est = sum((est_cost_for(meta, int(e["code_signals"]["est_input_tokens"]), _out_tokens(e)) or 0) for e in entries) if flagship_model else 0.0
    total = sum(entry_cost(e) for e in entries)
    counts: dict[str, int] = {}
    for e in entries:
        for r in e.get("reason", []):
            if str(r).startswith("override"):
                key = str(r).split(" → ")[0]
                counts[key] = counts.get(key, 0) + 1
    return Report(
        n=n, from_ts=entries[0]["ts"] if entries else None, to_ts=entries[-1]["ts"] if entries else None,
        tiers=tier_stats, models=models, total_cost=total, total_est_cost=sum(float(e.get("est_cost_usd") or 0) for e in entries),
        flagship_est_cost=flagship_est, flagship_model=flagship_model,
        saving_vs_flagship=(1 - total / flagship_est) if flagship_est > 0 else None,
        jev={"p50_ms": _pct([float(e["jev_latency_ms"]) for e in entries], 0.5), "p95_ms": _pct([float(e["jev_latency_ms"]) for e in entries], 0.95), "cost": sum(float(e["jev_input_tokens"]) * JEV_PRICE for e in entries)},
        degraded=sum(1 for e in entries if e.get("degraded")), fell_back=sum(1 for e in entries if e.get("fell_back")),
        low_confidence=sum(1 for e in entries if float(e["confidence"]) < 0.5),
        overrides=sorted(({"reason": k, "n": v} for k, v in counts.items()), key=lambda x: -x["n"]),
    )


@dataclass
class TuneResult:
    n: int
    baseline: dict[str, Any]
    candidate: dict[str, Any]
    moved_down: int
    moved_up: int
    unchanged: int
    saving: Optional[float]
    held_by_override: int
    moves: list[dict[str, Any]]


def tune(entries: Sequence[Mapping[str, Any]], baseline: Config, candidate: Config, tiers: Optional[Mapping[str, Sequence[str]]] = None) -> TuneResult:
    """Replay logged signals against a candidate config. No Jev calls: the signals are already in the log."""
    order = list(candidate["tiers"].keys())

    def count(ts: Sequence[str]) -> dict[str, int]:
        return {t: sum(1 for x in ts if x == t) for t in order}

    def cost(cfg: Config, e: Mapping[str, Any], tier: str) -> float:
        model = model_for_tier(cfg, tier, tiers)
        meta = (cfg.get("models") or {}).get(model) if model else None
        return est_cost_for(meta, int(e["code_signals"]["est_input_tokens"]), _out_tokens(e)) or 0.0

    def rules_only(cfg: Config) -> Config:
        return {**cfg, "overrides": []}  # type: ignore[return-value]

    base: list[str] = []
    cand: list[str] = []
    moves: list[dict[str, Any]] = []
    b_cost = c_cost = 0.0
    down = up = held = 0
    for e in entries:
        sig = Signals.from_dict(e["signals"])
        code = CodeSignals.from_dict(e["code_signals"])
        b = apply_policy(baseline, sig, code).tier
        c = apply_policy(candidate, sig, code).tier
        base.append(b)
        cand.append(c)
        b_cost += cost(baseline, e, b)
        c_cost += cost(candidate, e, c)
        if b != c:
            if order.index(c) < order.index(b):
                down += 1
            else:
                up += 1
            moves.append({"ts": e["ts"], "from": b, "to": c, "difficulty": sig.difficulty, "stakes": sig.stakes, "confidence": float(e["confidence"])})
        elif apply_policy(rules_only(baseline), sig, code).tier != apply_policy(rules_only(candidate), sig, code).tier:
            held += 1
    return TuneResult(
        n=len(entries), baseline={"tiers": count(base), "est_cost": b_cost}, candidate={"tiers": count(cand), "est_cost": c_cost},
        moved_down=down, moved_up=up, unchanged=len(entries) - down - up,
        saving=(1 - c_cost / b_cost) if b_cost > 0 else None, held_by_override=held, moves=moves,
    )
