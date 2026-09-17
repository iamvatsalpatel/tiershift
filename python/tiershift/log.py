"""Decision log: one JSON line per route. Signals, tier, model, cost, latency. Never message text. Port of src/log.ts."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .types import Decision

DEFAULT_LOG = ".tiershift/decisions.jsonl"

LOG_FIELDS = (
    "ts", "kind", "model", "tier", "requested_tier", "degraded", "fell_back", "confidence", "signals", "code_signals",
    "reason", "est_cost_usd", "cost_usd", "input_tokens", "output_tokens", "jev_latency_ms", "jev_input_tokens", "model_latency_ms",
)


def _now_iso() -> str:
    """ISO 8601 with milliseconds and a Z suffix, like JavaScript's toISOString()."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"


def log_entry(path: str, entry: dict[str, Any]) -> None:
    p = Path(path).resolve()
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")


def read_log(path: str) -> list[dict[str, Any]]:
    p = Path(path).resolve()
    if not p.exists():
        return []
    return [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]


def from_decision(d: Decision, kind: str, **extra: Any) -> dict[str, Any]:
    """Build a log entry. Keys and ordering match the TypeScript writer."""
    entry: dict[str, Any] = {
        "ts": _now_iso(),
        "kind": kind,
        "model": d.model,
        "tier": d.tier,
        "requested_tier": d.requested_tier,
        "degraded": d.degraded,
        "fell_back": False,
        "confidence": d.confidence,
        "signals": d.signals.to_dict(),
        "code_signals": d.code_signals.to_dict(),
        "reason": list(d.reason),
        "est_cost_usd": d.est_cost_usd,
        "cost_usd": None,
        "input_tokens": None,
        "output_tokens": None,
        "jev_latency_ms": d.jev_latency_ms,
        "jev_input_tokens": d.jev_input_tokens,
        "model_latency_ms": None,
    }
    for k, v in extra.items():
        if k == "tag" and v is None:
            continue
        entry[k] = v
    return entry
