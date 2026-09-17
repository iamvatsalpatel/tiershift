"""Opt-in live checks. Jev only (fraction of a cent) and Ollama. Never OpenAI, DeepSeek, or Anthropic."""

from __future__ import annotations

import os

import pytest

live = pytest.mark.skipif(not (os.environ.get("RUN_LIVE") == "1" and os.environ.get("TYPESAFE_API_KEY")), reason="set RUN_LIVE=1 and TYPESAFE_API_KEY")


@live
def test_route_live_jev_only():
    from tiershift import create_router
    r = create_router(env={"TYPESAFE_API_KEY": os.environ["TYPESAFE_API_KEY"]}, log=False)
    d = r.route([{"role": "user", "content": "ok thanks"}])
    assert d.signals.trivial_ack > 0.5 and d.jev_latency_ms > 0 and d.jev_input_tokens > 0
