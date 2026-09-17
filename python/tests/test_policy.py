from __future__ import annotations

import pytest

from tiershift import KNOWN_SIGNALS, CodeSignals, Signals, apply_policy, edit_distance, estimate_output_tokens, eval_condition, parse_condition, suggest

BASE = Signals(difficulty=0, difficulty_confidence=1, needs_reasoning=0, stakes=0, stakes_confidence=1, domain="general", domain_confidence=1, has_code=0, ambiguous=0, output_length=0, creative=0, safety_sensitive=0, trivial_ack=0, mid_tier_ok=0)
CODE = CodeSignals(est_input_tokens=100, has_tools=False, tool_count=0, step=None, retries=0, turn_count=1)
CFG = {
    "providers": {"x": {"type": "openai-compatible"}},
    "tiers": {"local": ["x/a"], "fast": ["x/b"], "mid": ["x/c"], "flagship": ["x/d"]},
    "rules": [{"when": "trivial_ack > 0.8", "tier": "local"}, {"when": "difficulty < 0.5", "tier": "fast"}, {"when": "difficulty < 1.3", "tier": "mid"}, {"default": "flagship"}],
    "overrides": [{"when": "stakes > 1.5", "at_least": "flagship"}, {"when": "needs_reasoning > 0.8", "at_least": "mid"}, {"when": "has_tools and tier == local", "at_least": "fast"}, {"when": "difficulty_confidence < 0.5", "up": 1}, {"when": "retries >= 1", "up": 1}],
}


def sig(**kw):
    d = BASE.to_dict(); d.update(kw); return Signals.from_dict(d)


def code(**kw):
    d = CODE.to_dict(); d.update(kw); return CodeSignals.from_dict(d)


class TestEvalCondition:
    V = {"difficulty": 0.7, "tier": "local", "has_tools": True, "retries": 0, "step": None}

    def test_numbers(self):
        assert eval_condition("difficulty < 1.3", self.V)
        assert eval_condition("difficulty >= 0.7", self.V)
        assert not eval_condition("difficulty > 0.7", self.V)

    def test_strings_and_booleans(self):
        assert eval_condition("tier == local", self.V)
        assert eval_condition('tier == "local"', self.V)
        assert eval_condition("has_tools", self.V)
        assert eval_condition("has_tools and tier == local", self.V)
        assert eval_condition("retries >= 1 or tier == local", self.V)
        assert not eval_condition("retries >= 1 and tier == local", self.V)

    def test_and_binds_tighter_than_or(self):
        # (retries >= 1 and tier == zzz) or has_tools  → true because has_tools
        assert eval_condition("retries >= 1 and tier == zzz or has_tools", self.V)

    def test_null_step_compares_as_string(self):
        assert eval_condition("step == null", self.V)
        assert not eval_condition("step == plan", self.V)

    def test_unknown_signal_with_suggestion(self):
        with pytest.raises(ValueError, match='unknown signal "difficlty" \\(did you mean "difficulty"\\?\\)'):
            eval_condition("difficlty > 1", self.V)
        with pytest.raises(ValueError, match='unknown signal "nope"'):
            eval_condition("nope > 1", self.V)

    def test_unparseable(self):
        with pytest.raises(ValueError, match='cannot parse "difficulty <> 1"'):
            eval_condition("difficulty <> 1", self.V)


class TestParse:
    def test_parse_condition_shapes(self):
        parsed = parse_condition("has_tools and tier == local or difficulty >= 0.5")
        assert [[a.name for a in clause] for clause in parsed] == [["has_tools", "tier"], ["difficulty"]]
        assert parsed[0][1].op == "==" and parsed[0][1].rhs == "local"

    def test_every_known_signal_parses(self):
        for name in KNOWN_SIGNALS:
            parse_condition(f"{name} == 1")

    def test_empty(self):
        for bad in ("", "   ", None):
            with pytest.raises(ValueError, match="empty condition"):
                parse_condition(bad)

    def test_edit_distance_and_suggest(self):
        assert edit_distance("kitten", "sitting") == 3
        assert suggest("difficlty") == ' (did you mean "difficulty"?)'
        assert suggest("zzzzzzzzzz") == ""
        assert suggest("fsat", ["local", "fast"]) == ' (did you mean "fast"?)'


class TestApplyPolicy:
    def test_trivial_ack_local(self):
        assert apply_policy(CFG, sig(trivial_ack=0.95), CODE).tier == "local"

    def test_difficulty_bands(self):
        assert apply_policy(CFG, sig(difficulty=0.2), CODE).tier == "fast"
        assert apply_policy(CFG, sig(difficulty=0.9), CODE).tier == "mid"
        assert apply_policy(CFG, sig(difficulty=1.8), CODE).tier == "flagship"

    def test_high_stakes_forces_flagship(self):
        r = apply_policy(CFG, sig(difficulty=0.1, stakes=1.9), CODE)
        assert r.tier == "flagship" and "at_least flagship" in " ".join(r.reason)

    def test_reasoning_lifts_to_mid(self):
        assert apply_policy(CFG, sig(difficulty=0.3, needs_reasoning=0.95), CODE).tier == "mid"

    def test_tools_lift_local(self):
        assert apply_policy(CFG, sig(trivial_ack=0.95), code(has_tools=True)).tier == "fast"

    def test_low_confidence_and_retries(self):
        assert apply_policy(CFG, sig(difficulty=0.3, difficulty_confidence=0.4), CODE).tier == "mid"
        assert apply_policy(CFG, sig(difficulty=0.3), code(retries=1)).tier == "mid"
        assert apply_policy(CFG, sig(difficulty=0.3, difficulty_confidence=0.4), code(retries=1)).tier == "flagship"

    def test_caps_at_top(self):
        assert apply_policy(CFG, sig(difficulty=1.9, difficulty_confidence=0.1), code(retries=3)).tier == "flagship"

    def test_unknown_tier_in_rule(self):
        bad = {**CFG, "rules": [{"default": "zzz"}]}
        with pytest.raises(ValueError, match='unknown tier "zzz"'):
            apply_policy(bad, BASE, CODE)

    def test_at_most_lowers_but_never_raises(self):
        cfg = {**CFG, "overrides": [{"when": "mid_tier_ok > 0.8 and stakes < 1.5", "at_most": "mid"}]}
        r = apply_policy(cfg, sig(difficulty=1.9, mid_tier_ok=0.9), CODE)
        assert r.tier == "mid" and r.reason[-1] == 'override "mid_tier_ok > 0.8 and stakes < 1.5" → at_most mid'
        assert apply_policy(cfg, sig(difficulty=1.9, mid_tier_ok=0.9, stakes=1.8), CODE).tier == "flagship"
        assert apply_policy(cfg, sig(difficulty=0.2, mid_tier_ok=0.9), CODE).tier == "fast"

    def test_reason_strings_match_typescript_format(self):
        r = apply_policy(CFG, sig(difficulty=0.3, difficulty_confidence=0.4), CODE)
        assert r.reason == ['rule "difficulty < 0.5" → fast', 'override "difficulty_confidence < 0.5" → up 1 → mid']


def test_estimate_output_tokens():
    assert estimate_output_tokens(0.1) == 50
    assert estimate_output_tokens(1.0) == 400
    assert estimate_output_tokens(1.9) == 2000
