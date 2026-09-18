"""Load and validate tiershift.yaml plus bundled prices.yaml. Port of src/config.ts."""

from __future__ import annotations

import json
import os
from importlib import resources
from pathlib import Path
from typing import Any, Mapping, Optional

import yaml

from .policy import parse_condition, suggest
from .types import Config, ModelMeta


def _bundled(name: str) -> str:
    return resources.files("tiershift").joinpath("data", name).read_text(encoding="utf-8")


def load_prices() -> dict[str, ModelMeta]:
    """Bundled model metadata. Users override any entry under `models:` in their config."""
    return yaml.safe_load(_bundled("prices.yaml")) or {}


def load_config(path: Optional[str] = None) -> Config:
    """Read `path`, else ./tiershift.yaml, else the bundled default. Validates and merges prices."""
    if path:
        text = Path(path).read_text(encoding="utf-8")
    elif Path("tiershift.yaml").exists():
        text = Path("tiershift.yaml").read_text(encoding="utf-8")
    else:
        text = _bundled("tiershift.yaml")
    cfg: Config = yaml.safe_load(text)
    validate(cfg)
    cfg["models"] = merge_model_meta(load_prices(), cfg.get("models") or {})
    return cfg


def merge_model_meta(bundled: Mapping[str, ModelMeta], overrides: Mapping[str, ModelMeta]) -> dict[str, ModelMeta]:
    """Per-model shallow merge. A config entry that only sets `params` keeps the bundled price and context."""
    out: dict[str, ModelMeta] = {k: dict(v) for k, v in bundled.items()}  # type: ignore[misc]
    for mid, meta in overrides.items():
        out[mid] = {**out.get(mid, {}), **meta}  # type: ignore[typeddict-item]
    return out


def _fail(where: str, what: str) -> None:
    """Raise `config: <where>: <what>` so a typo is found at load time, not on the first matching request."""
    raise ValueError(f"config: {where}: {what}")


def _check_condition(where: str, when: Any) -> None:
    if not isinstance(when, str) or not when.strip():
        _fail(where, "`when` must be a non-empty string")
    try:
        parse_condition(when)
    except ValueError as e:
        _fail(where, str(e))


def _check_tier_name(where: str, name: Any, tiers: list[str]) -> None:
    if not isinstance(name, str) or name not in tiers:
        _fail(where, f'unknown tier "{name}"{suggest(str(name), tiers)}. Tiers: {", ".join(tiers)}')


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def validate(cfg: Any) -> None:
    if not isinstance(cfg, dict):
        raise ValueError("config: file is empty or not a YAML mapping")
    if not cfg.get("providers"):
        raise ValueError("config: `providers` is empty")
    if not cfg.get("tiers"):
        raise ValueError("config: `tiers` is empty")
    rules = cfg.get("rules")
    if not isinstance(rules, list) or not rules:
        raise ValueError("config: `rules` is empty")
    tier_names = list(cfg["tiers"].keys())
    for tier, models in cfg["tiers"].items():
        if not isinstance(models, list) or not models:
            raise ValueError(f'config: tier "{tier}" has no models')
        for m in models:
            if not isinstance(m, str) or "/" not in m:
                _fail(f"tiers.{tier}", f'model "{m}" must be "provider/model"')
            prov = m.split("/", 1)[0]
            if prov not in cfg["providers"]:
                _fail(f"tiers.{tier}", f'model "{m}" uses unknown provider "{prov}"{suggest(prov, list(cfg["providers"].keys()))}')
    for name, p in cfg["providers"].items():
        if not isinstance(p, dict) or p.get("type") not in ("openai-compatible", "anthropic"):
            _fail(f"providers.{name}", '`type` must be "openai-compatible" or "anthropic"')
    for i, rule in enumerate(rules):
        where = f"rules[{i}]"
        if not isinstance(rule, dict):
            _fail(where, "must be a mapping")
        has_when, has_tier, has_default = "when" in rule, "tier" in rule, "default" in rule
        if has_default:
            if has_when or has_tier:
                _fail(where, "a `default` rule cannot also have `when` or `tier`")
            _check_tier_name(f"{where}.default", rule["default"], tier_names)
            if i != len(rules) - 1:
                _fail(where, "`default` must be the last rule; rules after it never run")
            continue
        if not has_when or not has_tier:
            _fail(where, "a rule needs both `when` and `tier`, or a single `default`")
        _check_condition(f"{where}.when", rule["when"])
        _check_tier_name(f"{where}.tier", rule["tier"], tier_names)
    for i, ov in enumerate(cfg.get("overrides") or []):
        where = f"overrides[{i}]"
        if not isinstance(ov, dict):
            _fail(where, "must be a mapping")
        _check_condition(f"{where}.when", ov.get("when"))
        actions = [k for k in ("at_least", "at_most", "up") if k in ov]
        if not actions:
            _fail(where, "needs one of `at_least`, `at_most`, or `up`")
        if "at_least" in ov:
            _check_tier_name(f"{where}.at_least", ov["at_least"], tier_names)
        if "at_most" in ov:
            _check_tier_name(f"{where}.at_most", ov["at_most"], tier_names)
        if "up" in ov and (not _is_int(ov["up"]) or ov["up"] <= 0):
            _fail(f"{where}.up", f"must be a positive integer, got {json.dumps(ov['up'])}")
    prefer = (cfg.get("budget") or {}).get("prefer")
    if prefer is not None and prefer not in ("order", "cheapest"):
        _fail("budget.prefer", 'must be "order" or "cheapest"')
    fb = cfg.get("fallback")
    if fb is not None and fb not in ("up", "none"):
        _fail("fallback", 'must be "up" or "none"')
    mot = (cfg.get("defaults") or {}).get("min_output_tokens")
    if mot is not None and (not _is_int(mot) or mot < 0):
        _fail("defaults.min_output_tokens", "must be a non-negative integer")
    gate = cfg.get("gate")
    if gate:
        th = gate.get("threshold")
        if th is not None and (isinstance(th, bool) or not isinstance(th, (int, float)) or th < 0 or th > 1):
            raise ValueError(f"config: gate.threshold: must be a number from 0 to 1, got {json.dumps(th)}")
        for tier in gate.get("tiers") or []:
            if tier not in cfg["tiers"]:
                raise ValueError(f'config: gate.tiers: unknown tier "{tier}". Tiers: {", ".join(tier_names)}')


def split_model(model_id: str) -> tuple[str, str]:
    """Split "provider/model-id" into parts. The model id may contain slashes or colons."""
    i = model_id.find("/")
    if i < 0:
        raise ValueError(f'Model id "{model_id}" must be "provider/model"')
    return model_id[:i], model_id[i + 1 :]


def has_key(cfg: Config, provider_name: str, env: Mapping[str, str]) -> bool:
    p = cfg["providers"].get(provider_name)
    if not p:
        return False
    key_env = p.get("api_key_env")
    if not key_env:
        return True  # local providers such as Ollama need no key
    return bool(env.get(key_env))


def available_tiers(cfg: Config, env: Optional[Mapping[str, str]] = None) -> dict[str, list[str]]:
    """Tiers filtered to models whose provider has a key (or needs none). A tier with no usable model keeps its full list."""
    e = os.environ if env is None else env
    out: dict[str, list[str]] = {}
    for tier, models in cfg["tiers"].items():
        av = [m for m in models if has_key(cfg, split_model(m)[0], e)]
        out[tier] = av if av else list(models)
    return out
