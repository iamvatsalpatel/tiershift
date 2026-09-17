from __future__ import annotations

import pytest

import copy

from tiershift import DEFAULT_JEV_MODEL, available_tiers, load_config, load_prices, merge_model_meta, split_model, validate


def test_bundled_default_loads_and_merges_prices():
    cfg = load_config()
    assert "tiers" in cfg and "flagship" in cfg["tiers"]
    # a models: override that only sets params keeps the bundled price
    flash = cfg["models"]["deepseek/deepseek-flash"]
    assert flash.get("params") and "price" in flash


def test_load_prices_has_entries():
    prices = load_prices()
    assert "anthropic/claude-fable-5-1" in prices
    assert prices["anthropic/claude-fable-5-1"]["price"]["input"] > 0


def test_merge_model_meta():
    bundled = {"a/x": {"price": {"input": 1, "output": 2}, "context": 1000}}
    m = merge_model_meta(bundled, {"a/x": {"params": {"k": 1}}, "b/y": {"context": 8}})
    assert m["a/x"] == {"price": {"input": 1, "output": 2}, "context": 1000, "params": {"k": 1}}
    assert m["b/y"] == {"context": 8}
    assert bundled["a/x"] == {"price": {"input": 1, "output": 2}, "context": 1000}  # not mutated


def test_split_model():
    assert split_model("ollama/qwen2.5:7b") == ("ollama", "qwen2.5:7b")
    assert split_model("openrouter/anthropic/claude-sonnet-5") == ("openrouter", "anthropic/claude-sonnet-5")
    with pytest.raises(ValueError, match="provider/model"):
        split_model("nope")


class TestValidate:
    BASE = {"providers": {"p": {"type": "openai-compatible"}}, "tiers": {"t": ["p/m"]}, "rules": [{"default": "t"}]}

    def test_minimal_ok(self):
        validate(self.BASE)

    def test_unknown_provider(self):
        with pytest.raises(ValueError, match='unknown provider "zzz"'):
            validate({**self.BASE, "tiers": {"t": ["zzz/m"]}})

    def test_empty_sections(self):
        with pytest.raises(ValueError, match="rules"):
            validate({**self.BASE, "rules": []})
        with pytest.raises(ValueError, match="tiers"):
            validate({**self.BASE, "tiers": {}})
        with pytest.raises(ValueError, match="providers"):
            validate({**self.BASE, "providers": {}})


def test_available_tiers():
    cfg = {"providers": {"a": {"type": "anthropic", "api_key_env": "A_KEY"}, "o": {"type": "openai-compatible"}}, "tiers": {"fast": ["a/x", "o/y"], "top": ["a/z"]}, "rules": [{"default": "top"}]}
    assert available_tiers(cfg, {}) == {"fast": ["o/y"], "top": ["a/z"]}
    assert available_tiers(cfg, {"A_KEY": "k"}) == {"fast": ["a/x", "o/y"], "top": ["a/z"]}


def test_cli_common_flags_in_either_position(tmp_path, capsys):
    from tiershift.cli import main
    cfg = tmp_path / "only.yaml"
    cfg.write_text("providers:\n  o: { type: openai-compatible, base_url: http://localhost:1/v1 }\ntiers:\n  local: [o/m]\nrules:\n  - { default: local }\nlog: { enabled: false }\n")
    assert main(["--config", str(cfg), "check"]) == 0
    before = capsys.readouterr().out
    assert main(["check", "--config", str(cfg)]) == 0
    after = capsys.readouterr().out
    assert before == after and "o/m" in before and "flagship" not in before


def _ok() -> dict:
    return copy.deepcopy({
        "providers": {"p": {"type": "openai-compatible", "base_url": "http://localhost:1/v1"}},
        "tiers": {"local": ["p/l"], "fast": ["p/f"], "mid": ["p/m"], "flagship": ["p/x"]},
        "rules": [{"when": "trivial_ack > 0.8", "tier": "local"}, {"when": "difficulty < 0.5", "tier": "fast"}, {"default": "flagship"}],
        "overrides": [{"when": "stakes > 1.5", "at_least": "flagship"}, {"when": "mid_tier_ok > 0.8", "at_most": "mid"}, {"when": "retries >= 1", "up": 1}],
    })


class TestLoadTimeValidation:
    def test_accepts_full_policy(self):
        validate(_ok())

    def test_misspelled_signal_names_location_and_suggests(self):
        c = _ok(); c["overrides"][1] = {"when": "difficlty > 1", "at_most": "mid"}
        with pytest.raises(ValueError) as ei:
            validate(c)
        assert str(ei.value) == 'config: overrides[1].when: unknown signal "difficlty" (did you mean "difficulty"?)'

    def test_unparsable_condition_quoted(self):
        c = _ok(); c["rules"][0]["when"] = "difficulty <> 0.5"
        with pytest.raises(ValueError, match=r'config: rules\[0\]\.when: cannot parse "difficulty <> 0.5"'):
            validate(c)

    def test_unknown_tiers_everywhere_with_suggestion(self):
        c = _ok(); c["rules"][1]["tier"] = "fsat"
        with pytest.raises(ValueError) as ei:
            validate(c)
        assert str(ei.value).startswith('config: rules[1].tier: unknown tier "fsat" (did you mean "fast"?)')
        c = _ok(); c["rules"][2] = {"default": "flagshp"}
        with pytest.raises(ValueError, match=r'rules\[2\]\.default: unknown tier "flagshp"'):
            validate(c)
        c = _ok(); c["overrides"][0]["at_least"] = "top"
        with pytest.raises(ValueError, match=r'overrides\[0\]\.at_least: unknown tier "top"'):
            validate(c)
        c = _ok(); c["overrides"][1]["at_most"] = "midd"
        with pytest.raises(ValueError) as ei2:
            validate(c)
        assert str(ei2.value).startswith('config: overrides[1].at_most: unknown tier "midd" (did you mean "mid"?)')

    def test_bad_up(self):
        for bad in (0, -1, 1.5, True):
            c = _ok(); c["overrides"][2] = {"when": "retries >= 1", "up": bad}
            with pytest.raises(ValueError, match=r"overrides\[2\]\.up: must be a positive integer"):
                validate(c)

    def test_rule_shape(self):
        c = _ok(); c["rules"][0] = {"when": "difficulty < 0.5"}
        with pytest.raises(ValueError, match=r"rules\[0\]: a rule needs both `when` and `tier`, or a single `default`"):
            validate(c)
        c = _ok(); c["rules"] = [{"default": "flagship"}, {"when": "difficulty < 0.5", "tier": "fast"}]
        with pytest.raises(ValueError, match=r"rules\[0\]: `default` must be the last rule"):
            validate(c)
        c = _ok(); c["rules"][2] = {"default": "flagship", "when": "difficulty < 0.5"}
        with pytest.raises(ValueError, match=r"rules\[2\]: a `default` rule cannot also have `when` or `tier`"):
            validate(c)

    def test_override_without_action(self):
        c = _ok(); c["overrides"][0] = {"when": "stakes > 1.5"}
        with pytest.raises(ValueError, match=r"overrides\[0\]: needs one of `at_least`, `at_most`, or `up`"):
            validate(c)

    def test_bad_enums_and_min_output_tokens(self):
        with pytest.raises(ValueError, match=r"budget\.prefer"):
            validate({**_ok(), "budget": {"prefer": "random"}})
        with pytest.raises(ValueError, match=r'fallback: must be "up" or "none"'):
            validate({**_ok(), "fallback": "sideways"})
        with pytest.raises(ValueError, match=r"defaults\.min_output_tokens"):
            validate({**_ok(), "defaults": {"min_output_tokens": -5}})

    def test_unknown_provider_suggests(self):
        c = _ok(); c["tiers"]["fast"] = ["q/f"]
        with pytest.raises(ValueError) as ei:
            validate(c)
        assert str(ei.value) == 'config: tiers.fast: model "q/f" uses unknown provider "q" (did you mean "p"?)'

    def test_bad_provider_type(self):
        c = _ok(); c["providers"]["p"]["type"] = "grpc"
        with pytest.raises(ValueError, match=r"providers\.p: `type` must be"):
            validate(c)

    def test_bundled_default_and_examples_validate(self):
        load_config()
        load_config(str(__import__("pathlib").Path(__file__).resolve().parents[2] / "examples" / "policies" / "bolder.yaml"))
        load_config(str(__import__("pathlib").Path(__file__).resolve().parents[2] / "conformance" / "policy-at-most.yaml"))


def test_pinned_jev_model_default():
    from tiershift import Router
    r = Router(config={**_ok(), "log": {"enabled": False}}, env={}, log=False)
    assert r._jev_model == DEFAULT_JEV_MODEL == "jev-1.13.0"
    r2 = Router(config={**_ok(), "log": {"enabled": False}, "jev": {"model": "jev-9.9.9"}}, env={}, log=False)
    assert r2._jev_model == "jev-9.9.9"
