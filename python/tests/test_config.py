from __future__ import annotations

import pytest

from tiershift import available_tiers, load_config, load_prices, merge_model_meta, split_model, validate


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
