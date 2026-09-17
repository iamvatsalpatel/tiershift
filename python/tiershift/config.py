"""Load and validate tiershift.yaml plus bundled prices.yaml. Port of src/config.ts."""

from __future__ import annotations

import os
from importlib import resources
from pathlib import Path
from typing import Any, Mapping, Optional

import yaml

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


def validate(cfg: Any) -> None:
    if not isinstance(cfg, dict):
        raise ValueError("config: top level must be a mapping")
    if not cfg.get("providers"):
        raise ValueError("config: `providers` is empty")
    if not cfg.get("tiers"):
        raise ValueError("config: `tiers` is empty")
    rules = cfg.get("rules")
    if not isinstance(rules, list) or not rules:
        raise ValueError("config: `rules` is empty")
    for tier, models in cfg["tiers"].items():
        if not isinstance(models, list) or not models:
            raise ValueError(f'config: tier "{tier}" has no models')
        for m in models:
            prov = str(m).split("/", 1)[0]
            if prov not in cfg["providers"]:
                raise ValueError(f'config: model "{m}" uses unknown provider "{prov}"')


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
