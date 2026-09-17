"""Provider adapters. tiershift decides which model; adapters make the call."""

from __future__ import annotations

import os
from typing import Mapping, Optional

from ..types import Config
from .anthropic import AnthropicProvider
from .base import CompletionRequest, CompletionResult, Provider, ProviderError
from .openai_compatible import OpenAICompatibleProvider

__all__ = ["AnthropicProvider", "CompletionRequest", "CompletionResult", "OpenAICompatibleProvider", "Provider", "ProviderError", "build_providers"]


def build_providers(config: Config, env: Optional[Mapping[str, str]] = None) -> dict[str, Provider]:
    """Build Provider instances from the `providers:` section. Providers without a key are skipped."""
    e = os.environ if env is None else env
    out: dict[str, Provider] = {}
    for name, p in config["providers"].items():
        key_env = p.get("api_key_env")
        api_key = e.get(key_env) if key_env else None
        if key_env and not api_key:
            continue
        if p.get("type") == "anthropic":
            out[name] = AnthropicProvider(name=name, api_key=api_key, base_url=p.get("base_url"))
        else:
            out[name] = OpenAICompatibleProvider(name=name, base_url=p.get("base_url") or "https://api.openai.com/v1", api_key=api_key)
    return out
