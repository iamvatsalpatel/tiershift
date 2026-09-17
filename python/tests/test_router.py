"""Router tests with a fake Jev client and fake providers. No network."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import pytest

from tiershift import Router, read_log
from tiershift.providers import CompletionRequest, CompletionResult, ProviderError


@dataclass
class _Ans:
    score: float = 0.0
    confidence: float = 1.0
    noul: float = 0.0
    choice: str = "general"


class FakeJev:
    """Returns the same answers every call. Set `difficulty`, `stakes`, `trivial_ack`, etc. per test."""

    def __init__(self, **over):
        self.over = over
        self.calls = 0

    def system_one(self, state, questions, model=None, timeout=None):
        self.calls += 1
        self.last_state = state
        o = self.over
        answers = {
            "difficulty": _Ans(score=o.get("difficulty", 0.2), confidence=o.get("difficulty_confidence", 0.9)),
            "needs_reasoning": _Ans(noul=o.get("needs_reasoning", 0.1)),
            "stakes": _Ans(score=o.get("stakes", 0.1), confidence=o.get("stakes_confidence", 0.9)),
            "domain": _Ans(choice=o.get("domain", "general"), confidence=0.9),
            "has_code": _Ans(noul=0.0), "ambiguous": _Ans(noul=0.0),
            "output_length": _Ans(score=o.get("output_length", 1.0), confidence=0.9),
            "creative": _Ans(noul=0.0), "safety_sensitive": _Ans(noul=o.get("safety_sensitive", 0.0)),
            "trivial_ack": _Ans(noul=o.get("trivial_ack", 0.0)),
            "mid_tier_ok": _Ans(noul=o.get("mid_tier_ok", 0.0)),
        }
        usage = type("U", (), {"input_tokens": 900, "output_tokens": 40})()
        return type("R", (), {"answers": answers, "usage": usage})()


class FakeProvider:
    def __init__(self, name, *, fail_status=None, text="ok"):
        self.name = name
        self.fail_status = fail_status
        self.text = text
        self.calls: list[CompletionRequest] = []

    def complete(self, req: CompletionRequest) -> CompletionResult:
        self.calls.append(req)
        if self.fail_status == "network":
            raise ProviderError(self.name, None, "connection refused")
        if self.fail_status:
            raise ProviderError(self.name, self.fail_status, f"http {self.fail_status}")
        return CompletionResult(text=self.text, tool_calls=[], finish_reason="stop", input_tokens=10, output_tokens=5, served_model=req.model, latency_ms=12, raw={})


CFG = {
    "providers": {"loc": {"type": "openai-compatible", "base_url": "http://localhost:1/v1"}, "cloud": {"type": "openai-compatible", "api_key_env": "CLOUD_KEY"}},
    "tiers": {"local": ["loc/small"], "fast": ["cloud/fast"], "mid": ["cloud/mid"], "flagship": ["cloud/big"]},
    "models": {
        "loc/small": {"price": {"input": 0, "output": 0}, "context": 4000, "caps": ["tools"]},
        "cloud/fast": {"price": {"input": 0.2, "output": 1.0}, "caps": ["tools"]},
        "cloud/mid": {"price": {"input": 2.0, "output": 10.0}, "caps": ["reasoning"]},
        "cloud/big": {"price": {"input": 10.0, "output": 50.0}, "caps": ["tools"]},
    },
    "rules": [{"when": "trivial_ack > 0.8", "tier": "local"}, {"when": "difficulty < 0.5", "tier": "fast"}, {"when": "difficulty < 1.3", "tier": "mid"}, {"default": "flagship"}],
    "overrides": [{"when": "stakes > 1.5", "at_least": "flagship"}],
    "budget": {"max_cost_per_call": 0.10},
    "log": {"enabled": False},
}
MSGS = [{"role": "user", "content": "hello there"}]


def make(env=None, jev=None, providers=None, **cfg_over):
    cfg = {**CFG, **cfg_over}
    return Router(config=cfg, env=env if env is not None else {"CLOUD_KEY": "k"}, jev_client=jev or FakeJev(), providers=providers, log=False)


def test_route_basic_fast_tier():
    r = make(jev=FakeJev(difficulty=0.2))
    d = r.route(MSGS, tag="t")
    assert d.tier == "fast" and d.model == "cloud/fast" and d.fallback == "cloud/mid" and not d.degraded
    assert d.reason == ['rule "difficulty < 0.5" → fast']
    assert d.est_cost_usd == pytest.approx((d.code_signals.est_input_tokens * 0.2 + 400 * 1.0) / 1e6)
    assert d.code_signals.est_input_tokens == 4  # ceil((len('hello there') + len('[]')) / 4)
    assert d.jev_input_tokens == 900 and d.code_signals.turn_count == 1


def test_state_sent_to_jev_is_trimmed_and_shaped():
    jev = FakeJev()
    r = make(jev=jev)
    r.route([{"role": "system", "content": "S" * 1000}, {"role": "user", "content": "first"}, {"role": "assistant", "content": "a"}, {"role": "user", "content": "second"}], tools=[{"name": "search"}], step="plan", retries=2)
    req = jev.last_state["request"]
    assert len(req["system_prompt"]) == 500 and req["user_message"] == "second" and req["previous_assistant_message"] == "a"
    assert req["tool_names"] == ["search"] and req["step"] == "plan" and req["retries"] == 2


def test_high_stakes_goes_flagship():
    d = make(jev=FakeJev(difficulty=0.1, stakes=1.9)).route(MSGS)
    assert d.tier == "flagship" and d.fallback is None


def test_walks_up_when_tools_unsupported():
    # mid has no tools cap; a mid-difficulty prompt with tools walks up to flagship
    d = make(jev=FakeJev(difficulty=0.9)).route(MSGS, tools=[{"name": "f"}])
    assert d.tier == "flagship" and "skip cloud/mid: no tools capability" in d.reason and "walked up to flagship" in d.reason


def test_budget_skips_expensive_model():
    # 20k input tokens on the flagship at $10/M = $0.20 > $0.10 budget → nothing at or above fits → degrade
    long_msgs = [{"role": "user", "content": "x" * 80000}]
    d = make(jev=FakeJev(difficulty=1.9)).route(long_msgs)
    assert any("> budget" in r for r in d.reason)
    assert d.degraded and d.requested_tier == "flagship"


def test_degrade_when_no_cloud_key():
    d = make(env={}, jev=FakeJev(difficulty=1.9)).route(MSGS)
    assert d.model == "loc/small" and d.tier == "local" and d.degraded and d.requested_tier == "flagship"
    assert d.reason[-1].startswith("DEGRADED")


def test_degrade_false_raises():
    with pytest.raises(RuntimeError, match="No model fits"):
        make(env={}, jev=FakeJev(difficulty=1.9), degrade=False).route(MSGS)




def test_available():
    assert make().available() == {"local": ["loc/small"], "fast": ["cloud/fast"], "mid": ["cloud/mid"], "flagship": ["cloud/big"]}
    assert make(env={}).available() == {"local": ["loc/small"], "fast": [], "mid": [], "flagship": []}


def test_complete_success_logs_actual_usage(tmp_path: Path):
    p = FakeProvider("cloud")
    r = Router(config={**CFG, "log": {"enabled": True}}, env={"CLOUD_KEY": "k"}, jev_client=FakeJev(difficulty=0.2), providers={"cloud": p, "loc": FakeProvider("loc")}, log=str(tmp_path / "d.jsonl"))
    res = r.complete(MSGS, max_tokens=77, tag="agent-a")
    assert res.model == "cloud/fast" and not res.fell_back and res.text == "ok"
    assert p.calls[0].max_tokens == 77 and p.calls[0].model == "fast"
    assert res.cost_usd == pytest.approx((10 * 0.2 + 5 * 1.0) / 1e6)
    entries = read_log(str(tmp_path / "d.jsonl"))
    assert len(entries) == 1 and entries[0]["kind"] == "complete" and entries[0]["output_tokens"] == 5 and entries[0]["tag"] == "agent-a"
    assert "hello there" not in json.dumps(entries)


def test_complete_falls_back_on_5xx():
    fast_then_mid = FakeProvider("cloud")
    calls = {"n": 0}

    def complete(req):
        calls["n"] += 1
        if req.model == "fast":
            raise ProviderError("cloud", 503, "down")
        return CompletionResult(text="from mid", tool_calls=[], finish_reason="stop", input_tokens=1, output_tokens=1, served_model=req.model, latency_ms=1)
    fast_then_mid.complete = complete  # type: ignore[method-assign]
    res = make(jev=FakeJev(difficulty=0.2), providers={"cloud": fast_then_mid, "loc": FakeProvider("loc")}).complete(MSGS)
    assert res.fell_back and res.model == "cloud/mid" and res.text == "from mid"
    assert [a.ok for a in res.attempts] == [False, True] and res.attempts[0].status == 503


def test_complete_does_not_fall_back_on_4xx():
    p = FakeProvider("cloud", fail_status=400)
    with pytest.raises(RuntimeError, match="every candidate failed"):
        make(jev=FakeJev(difficulty=0.2), providers={"cloud": p, "loc": FakeProvider("loc")}).complete(MSGS)
    assert len(p.calls) == 1  # fallback was not attempted


def test_complete_falls_back_on_network_error():
    p = FakeProvider("cloud")
    seen = []

    def complete(req):
        seen.append(req.model)
        if req.model == "fast":
            raise ProviderError("cloud", None, "connection refused")
        return CompletionResult(text="ok", tool_calls=[], finish_reason="stop", input_tokens=1, output_tokens=1, served_model=req.model, latency_ms=1)
    p.complete = complete  # type: ignore[method-assign]
    res = make(jev=FakeJev(difficulty=0.2), providers={"cloud": p, "loc": FakeProvider("loc")}).complete(MSGS)
    assert seen == ["fast", "mid"] and res.fell_back


def test_log_disabled_in_config_wins_over_path(tmp_path: Path):
    r = Router(config=CFG, env={"CLOUD_KEY": "k"}, jev_client=FakeJev(), log=str(tmp_path / "x.jsonl"))
    r.route(MSGS)
    assert r.log_path is None and not (tmp_path / "x.jsonl").exists()


def test_route_log_entry_matches_contract(tmp_path: Path):
    r = Router(config={**CFG, "log": {"enabled": True}}, env={"CLOUD_KEY": "k"}, jev_client=FakeJev(difficulty=0.9), log=str(tmp_path / "x.jsonl"))
    r.route(MSGS)
    e = read_log(str(tmp_path / "x.jsonl"))[0]
    assert e["kind"] == "route" and e["cost_usd"] is None and e["output_tokens"] is None and "tag" not in e
    assert e["ts"].endswith("Z") and len(e["ts"]) == 24


def test_check_works_without_typesafe_key():
    r = Router(config=CFG, env={"CLOUD_KEY": "k"}, log=False)  # no jev_client, no TYPESAFE_API_KEY
    assert r.available()["fast"] == ["cloud/fast"]
    with pytest.raises(RuntimeError, match="TYPESAFE_API_KEY is not set"):
        r.route(MSGS)


def test_reasoning_floor_raises_max_tokens_and_says_so():
    p = FakeProvider("cloud")
    res = make(jev=FakeJev(difficulty=0.9), providers={"cloud": p, "loc": FakeProvider("loc")}).complete(MSGS, max_tokens=200)
    assert res.model == "cloud/mid" and p.calls[0].max_tokens == 1024
    assert "raised max_tokens to 1024 for reasoning model cloud/mid" in res.decision.reason
    # configurable floor
    p2 = FakeProvider("cloud")
    res2 = make(jev=FakeJev(difficulty=0.9), providers={"cloud": p2, "loc": FakeProvider("loc")}, defaults={"min_output_tokens": 3000}).complete(MSGS, max_tokens=200)
    assert p2.calls[0].max_tokens == 3000 and "raised max_tokens to 3000 for reasoning model cloud/mid" in res2.decision.reason
    # already above the floor: untouched, no reason line
    p3 = FakeProvider("cloud")
    res3 = make(jev=FakeJev(difficulty=0.9), providers={"cloud": p3, "loc": FakeProvider("loc")}).complete(MSGS, max_tokens=5000)
    assert p3.calls[0].max_tokens == 5000 and not any(r.startswith("raised max_tokens") for r in res3.decision.reason)


def test_no_floor_for_non_reasoning_model():
    p = FakeProvider("cloud")
    res = make(jev=FakeJev(difficulty=0.2), providers={"cloud": p, "loc": FakeProvider("loc")}).complete(MSGS, max_tokens=200)
    assert res.model == "cloud/fast" and p.calls[0].max_tokens == 200 and not any(r.startswith("raised") for r in res.decision.reason)


def test_empty_answer_with_length_finish_is_a_failure_and_falls_back():
    p = FakeProvider("cloud")
    seen = []

    def complete(req):
        seen.append(req.model)
        if req.model == "fast":
            return CompletionResult(text="   ", tool_calls=[], finish_reason="length", input_tokens=10, output_tokens=200, served_model=req.model, latency_ms=5)
        return CompletionResult(text="real answer", tool_calls=[], finish_reason="stop", input_tokens=10, output_tokens=20, served_model=req.model, latency_ms=5)
    p.complete = complete  # type: ignore[method-assign]
    res = make(jev=FakeJev(difficulty=0.2), providers={"cloud": p, "loc": FakeProvider("loc")}).complete(MSGS, max_tokens=200)
    assert seen == ["fast", "mid"] and res.fell_back and res.text == "real answer"
    assert res.attempts[0].ok is False and res.attempts[0].error.startswith("cloud: empty_answer:length") and "200 output tokens billed" in res.attempts[0].error


def test_empty_answer_with_stop_finish_is_not_a_failure():
    p = FakeProvider("cloud", text="")
    res = make(jev=FakeJev(difficulty=0.2), providers={"cloud": p, "loc": FakeProvider("loc")}).complete(MSGS)
    assert res.text == "" and not res.fell_back and len(p.calls) == 1


def test_api_keys_are_redacted_from_attempt_errors_and_thrown_message():
    secret = "sk-live-ABCDEFGH12345678"
    p = FakeProvider("cloud")

    def complete(req):
        raise ProviderError("cloud", 500, f"upstream echoed Authorization: Bearer {secret} and TS key ts_SECRETKEY_0001")
    p.complete = complete  # type: ignore[method-assign]
    router = Router(config=CFG, env={"CLOUD_KEY": secret, "TYPESAFE_API_KEY": "ts_SECRETKEY_0001"}, jev_client=FakeJev(difficulty=0.2), providers={"cloud": p, "loc": FakeProvider("loc")}, log=False)
    with pytest.raises(RuntimeError) as ei:
        router.complete(MSGS)
    msg = str(ei.value)
    assert secret not in msg and "ts_SECRETKEY_0001" not in msg and msg.count("[redacted]") >= 2


def test_redaction_applies_to_attempt_records_on_fallback_success():
    secret = "sk-live-ABCDEFGH12345678"
    p = FakeProvider("cloud")

    def complete(req):
        if req.model == "fast":
            raise ProviderError("cloud", 503, f"bad gateway; header was {secret}")
        return CompletionResult(text="ok", tool_calls=[], finish_reason="stop", input_tokens=1, output_tokens=1, served_model=req.model, latency_ms=1)
    p.complete = complete  # type: ignore[method-assign]
    router = Router(config=CFG, env={"CLOUD_KEY": secret}, jev_client=FakeJev(difficulty=0.2), providers={"cloud": p, "loc": FakeProvider("loc")}, log=False)
    res = router.complete(MSGS)
    assert res.fell_back and secret not in res.attempts[0].error and "[redacted]" in res.attempts[0].error
