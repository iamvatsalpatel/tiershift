from __future__ import annotations

import json
from pathlib import Path

import pytest

from tiershift import CodeSignals, Decision, Signals, build_report, from_decision, log_entry, read_log, tune

SIG = dict(difficulty=1.0, difficulty_confidence=0.8, needs_reasoning=0.5, stakes=0.2, stakes_confidence=0.9, domain="code", domain_confidence=0.9, has_code=0.9, ambiguous=0.1, output_length=1.0, creative=0.0, safety_sensitive=0.0, trivial_ack=0.0, mid_tier_ok=0.3)
CODE = dict(est_input_tokens=1000, has_tools=False, tool_count=0, step=None, retries=0, turn_count=1)
CFG = {
    "providers": {"p": {"type": "openai-compatible"}},
    "tiers": {"local": ["p/l"], "fast": ["p/f"], "mid": ["p/m"], "flagship": ["p/x"]},
    "rules": [{"when": "trivial_ack > 0.8", "tier": "local"}, {"when": "difficulty < 0.5", "tier": "fast"}, {"when": "difficulty < 1.3", "tier": "mid"}, {"default": "flagship"}],
    "overrides": [{"when": "stakes > 1.5", "at_least": "flagship"}],
    "models": {"p/l": {"price": {"input": 0, "output": 0}}, "p/f": {"price": {"input": 0.2, "output": 1}}, "p/m": {"price": {"input": 2, "output": 10}}, "p/x": {"price": {"input": 10, "output": 50}}},
}


def decision(**over) -> Decision:
    base = dict(model="p/m", provider="p", tier="mid", tier_index=2, requested_tier="mid", degraded=False, fallback="p/x", fallback_tier="flagship", est_flagship_cost_usd=0.04, est_flagship_model="p/x", signals=Signals(**SIG), code_signals=CodeSignals(**CODE),
                confidence=0.8, reason=['rule "difficulty < 1.3" → mid'], est_cost_usd=0.004, est_output_tokens=400, jev_latency_ms=210, jev_input_tokens=950)
    base.update(over)
    return Decision(**base)


def entry(tier, model, difficulty, kind="route", **over):
    e = from_decision(decision(model=model, tier=tier, requested_tier=tier, signals=Signals(**{**SIG, "difficulty": difficulty})), kind, **over)
    e["ts"] = "2026-09-17T00:00:00.000Z"
    return e


def test_log_round_trip(tmp_path: Path):
    path = tmp_path / "nested" / "d.jsonl"
    log_entry(str(path), from_decision(decision(), "route", tag="agent-a"))
    log_entry(str(path), from_decision(decision(), "complete", cost_usd=0.0031, input_tokens=100, output_tokens=50, model_latency_ms=900))
    rows = read_log(str(path))
    assert len(rows) == 2
    assert rows[0]["kind"] == "route" and rows[0]["tag"] == "agent-a" and rows[0]["cost_usd"] is None and rows[0]["est_cost_usd"] == 0.004
    assert rows[1]["kind"] == "complete" and rows[1]["output_tokens"] == 50
    assert "prompt" not in json.dumps(rows[0])
    assert read_log(str(tmp_path / "missing.jsonl")) == []


def test_build_report():
    entries = [entry("fast", "p/f", 0.2, est_cost_usd=0.0006), entry("fast", "p/f", 0.3, est_cost_usd=0.0006), entry("flagship", "p/x", 1.9, est_cost_usd=0.03, reason=['override "stakes > 1.5" → at_least flagship'])]
    r = build_report(entries, CFG)
    assert r.n == 3
    assert next(t for t in r.tiers if t.tier == "fast").n == 2
    assert next(t for t in r.tiers if t.tier == "flagship").share == pytest.approx(1 / 3)
    assert r.total_cost == pytest.approx(0.0312)
    assert r.flagship_est_cost == pytest.approx(0.09)  # 1000 in * $10 + 400 out * $50 per 1M, times 3
    assert r.saving_vs_flagship == pytest.approx(1 - 0.0312 / 0.09)
    assert r.overrides[0] == {"reason": 'override "stakes > 1.5"', "n": 1}
    assert r.jev["p50_ms"] == 210


def test_report_prefers_actual_cost_and_handles_empty():
    r = build_report([entry("mid", "p/m", 1.0, kind="complete", est_cost_usd=0.01, cost_usd=0.02)], CFG)
    assert r.total_cost == pytest.approx(0.02)
    empty = build_report([], CFG)
    assert empty.n == 0 and empty.saving_vs_flagship is None


def test_report_estimate_check_per_tier():
    r = build_report([entry("mid", "p/m", 1.0, kind="complete", est_cost_usd=0.01, cost_usd=0.02), entry("mid", "p/m", 1.0, est_cost_usd=0.01)], CFG)
    mid = next(t for t in r.tiers if t.tier == "mid")
    assert mid.estimate_check == {"n": 1, "est": 0.01, "actual": 0.02, "ratio": 0.5}
    assert next(t for t in r.tiers if t.tier == "fast").estimate_check is None


def test_report_uses_supplied_available_tiers_for_baseline():
    r = build_report([entry("mid", "p/m", 1.0)], CFG, tiers={**CFG["tiers"], "flagship": ["p/m"]})
    assert r.flagship_model == "p/m"


def test_tune_moves_and_saving():
    entries = [entry("mid", "p/m", 0.9), entry("mid", "p/m", 1.1), entry("flagship", "p/x", 1.5), entry("flagship", "p/x", 1.9)]
    bolder = {**CFG, "rules": [{"when": "trivial_ack > 0.8", "tier": "local"}, {"when": "difficulty < 0.5", "tier": "fast"}, {"when": "difficulty < 1.6", "tier": "mid"}, {"default": "flagship"}]}
    t = tune(entries, CFG, bolder)
    assert t.baseline["tiers"] == {"local": 0, "fast": 0, "mid": 2, "flagship": 2}
    assert t.candidate["tiers"] == {"local": 0, "fast": 0, "mid": 3, "flagship": 1}
    assert (t.moved_down, t.moved_up, t.unchanged) == (1, 0, 3)
    assert t.moves[0]["from"] == "flagship" and t.moves[0]["to"] == "mid" and t.moves[0]["difficulty"] == 1.5
    assert t.saving is not None and t.saving > 0


def test_tune_held_by_override():
    e = entry("flagship", "p/x", 1.5)
    e["signals"]["difficulty_confidence"] = 0.3
    with_low = {**CFG, "overrides": [{"when": "difficulty_confidence < 0.5", "up": 1}]}
    bolder = {**with_low, "rules": [{"when": "difficulty < 1.6", "tier": "mid"}, {"default": "flagship"}]}
    t = tune([e], with_low, bolder)
    assert t.unchanged == 1 and t.held_by_override == 1
