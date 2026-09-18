"""Answer gate: after a fast-tier answer, one Jev call; below threshold retry one tier up; everything billed is logged. Mirrors src/gate.test.ts."""

from __future__ import annotations

import json
from dataclasses import dataclass

import pytest

from tiershift import Router, read_log, validate
from tiershift.providers import CompletionRequest, CompletionResult
from tiershift.types import ToolCall

JEV_PRICE = 0.042 / 1e6


def cfg(gate=None):
    c = {
        "providers": {"o": {"type": "openai-compatible", "base_url": "http://localhost:1/v1"}},
        "tiers": {"fast": ["o/f"], "mid": ["o/m"], "flagship": ["o/x"]},
        "rules": [{"default": "fast"}],
        "models": {"o/f": {"price": {"input": 1, "output": 1}}, "o/m": {"price": {"input": 10, "output": 10}}, "o/x": {"price": {"input": 100, "output": 100}}},
        "jev": {"model": "jev-1.13.0"},
    }
    if gate is not None:
        c["gate"] = gate
    return c


@dataclass
class _Ans:
    score: float = 0.0
    confidence: float = 0.9
    noul: float = 0.0
    choice: str = "general"


class GateJev:
    """Routing questions get easy signals; the gate question returns `addresses`."""

    def __init__(self, addresses: float):
        self.addresses = addresses
        self.calls: list[str] = []

    def system_one(self, state, questions, model=None, timeout=None):
        if "addresses" in questions:
            self.calls.append("gate")
            return type("R", (), {"answers": {"addresses": _Ans(noul=self.addresses)}, "usage": type("U", (), {"input_tokens": 380, "output_tokens": 5})()})()
        self.calls.append("route")
        answers = {
            "difficulty": _Ans(score=0.1), "needs_reasoning": _Ans(noul=0.0), "stakes": _Ans(score=0.0), "domain": _Ans(choice="general"),
            "has_code": _Ans(), "ambiguous": _Ans(), "output_length": _Ans(score=0.0), "creative": _Ans(), "safety_sensitive": _Ans(),
            "trivial_ack": _Ans(), "mid_tier_ok": _Ans(noul=0.9),
        }
        return type("R", (), {"answers": answers, "usage": type("U", (), {"input_tokens": 900, "output_tokens": 30})()})()


class Prov:
    def __init__(self, tool_calls: bool = False):
        self.name = "o"
        self.calls: list[str] = []
        self.tool_calls = tool_calls

    def complete(self, req: CompletionRequest) -> CompletionResult:
        self.calls.append(req.model)
        if self.tool_calls:
            return CompletionResult(text="", tool_calls=[ToolCall(id="1", name="t", arguments="{}")], finish_reason="tool_calls", input_tokens=1, output_tokens=1, served_model=req.model, latency_ms=1, raw={})
        return CompletionResult(text=f"{req.model} says hi", tool_calls=[], finish_reason="stop", input_tokens=100, output_tokens=100, served_model=req.model, latency_ms=5, raw={})


MSGS = [{"role": "user", "content": "hi"}]


def make(gate, jev, prov, log):
    return Router(config=cfg(gate), env={}, jev_client=jev, providers={"o": prov}, log=log)


def test_off_by_default_no_gate_call_served_cost_only(tmp_path):
    j, p, log = GateJev(0.1), Prov(), str(tmp_path / "d.jsonl")
    r = make(None, j, p, log).complete(MSGS)
    assert j.calls == ["route"] and p.calls == ["f"] and r.gate is None
    assert r.cost_usd == pytest.approx(0.0002) and r.total_cost_usd == pytest.approx(0.0002)


def test_pass_adds_gate_cost_to_total_and_logs_gate_addresses(tmp_path):
    j, p, log = GateJev(0.9), Prov(), str(tmp_path / "d.jsonl")
    r = make({"enabled": True, "threshold": 0.5}, j, p, log).complete(MSGS)
    assert j.calls == ["route", "gate"] and p.calls == ["f"]
    assert r.gate is not None and r.gate.addresses == 0.9 and r.gate.threshold == 0.5 and r.gate.passed
    assert r.model == "o/f" and not r.fell_back
    assert r.total_cost_usd > r.cost_usd
    assert r.total_cost_usd == pytest.approx(0.0002 + 380 * JEV_PRICE, abs=1e-9)
    entry = read_log(log)[0]
    assert entry["gate_addresses"] == 0.9 and entry["cost_usd"] == pytest.approx(r.total_cost_usd, abs=1e-9)


def test_fail_retries_one_tier_up_bills_both_logs_fallback_tier(tmp_path):
    j, p, log = GateJev(0.2), Prov(), str(tmp_path / "d.jsonl")
    r = make({"enabled": True, "threshold": 0.5}, j, p, log).complete(MSGS)
    assert p.calls == ["f", "m"] and r.model == "o/m" and r.fell_back and r.text == "m says hi"
    assert [a.ok for a in r.attempts] == [False, True]
    assert "gate:addresses 0.20 < 0.5" in (r.attempts[0].error or "")
    assert any("gate: P(addresses)=0.20 < 0.5 on o/f → retry on o/m" in x for x in r.decision.reason)
    # total = fast answer 0.0002 + gate + mid answer 0.002; mid is not gated (not in the tier list)
    assert r.total_cost_usd == pytest.approx(0.0002 + 380 * JEV_PRICE + 0.002, abs=1e-9)
    assert j.calls == ["route", "gate"]
    entry = read_log(log)[0]
    assert entry["tier"] == "mid" and entry["fell_back"] is True and entry["cost_usd"] == pytest.approx(r.total_cost_usd, abs=1e-9)
    assert "gate_addresses" not in entry  # the served (mid) answer was not gated


def test_gates_only_listed_tiers_and_never_tool_calls():
    j, p = GateJev(0.1), Prov()
    r1 = make({"enabled": True, "tiers": ["mid"]}, j, p, False).complete(MSGS)
    assert r1.gate is None and p.calls == ["f"] and j.calls == ["route"]
    j2 = GateJev(0.1)
    r2 = make({"enabled": True}, j2, Prov(tool_calls=True), False).complete(MSGS)
    assert r2.gate is None and j2.calls == ["route"]


def test_never_gates_the_last_candidate():
    # fallback: none → the fast answer has no next candidate, so no gate call even when enabled
    j, p = GateJev(0.1), Prov()
    c = cfg({"enabled": True}); c["fallback"] = "none"
    r = Router(config=c, env={}, jev_client=j, providers={"o": p}, log=False).complete(MSGS)
    assert r.gate is None and j.calls == ["route"] and r.model == "o/f"


def test_rejects_bad_gate_config():
    with pytest.raises(ValueError, match=r"gate\.threshold"):
        validate(cfg({"threshold": 1.5}))
    with pytest.raises(ValueError, match=r'gate\.tiers: unknown tier "nope"'):
        validate(cfg({"tiers": ["nope"]}))


def test_route_carries_flagship_reference_cost():
    j = GateJev(0.9)
    d = make(None, j, Prov(), False).route(MSGS)
    assert d.est_flagship_model == "o/x"
    # est tokens for "hi" plus "[]" = 1; output bucket 0.0 → 50 tokens; flagship price 100/100 per M
    assert d.est_flagship_cost_usd == pytest.approx((1 * 100 + 50 * 100) / 1e6)
    assert d.est_cost_usd == pytest.approx((1 * 1 + 50 * 1) / 1e6)
    assert d.fallback == "o/m" and d.fallback_tier == "mid"
