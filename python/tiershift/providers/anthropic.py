"""Thin Anthropic Messages API adapter over httpx. No SDK dependency."""

from __future__ import annotations

import json
import time
from typing import Any, Optional

import httpx

from ..types import ToolCall
from .base import CompletionRequest, CompletionResult, ProviderError

ANTHROPIC_VERSION = "2023-06-01"


class AnthropicProvider:
    def __init__(self, name: str, api_key: Optional[str] = None, base_url: Optional[str] = None, timeout_s: float = 120.0, client: Optional[httpx.Client] = None) -> None:
        self.name = name
        self.api_key = api_key
        self.base_url = (base_url or "https://api.anthropic.com").rstrip("/")
        self.timeout_s = timeout_s
        self._client = client

    def build_body(self, req: CompletionRequest) -> dict[str, Any]:
        system = "\n\n".join(m.get("content", "") for m in req.messages if m.get("role") == "system")
        body: dict[str, Any] = {
            "model": req.model,
            "max_tokens": req.max_tokens or 16000,
            "messages": [{"role": m["role"], "content": m.get("content", "")} for m in req.messages if m.get("role") in ("user", "assistant")],
        }
        if system:
            body["system"] = system
        if req.tools:
            body["tools"] = [{"name": t["name"], "description": t.get("description"), "input_schema": t.get("parameters") or {"type": "object", "properties": {}}} for t in req.tools]
        if req.temperature is not None:
            body["temperature"] = req.temperature
        if req.params:
            body.update(req.params)
        return body

    def complete(self, req: CompletionRequest) -> CompletionResult:
        headers = {"Content-Type": "application/json", "anthropic-version": ANTHROPIC_VERSION}
        if self.api_key:
            headers["x-api-key"] = self.api_key
        t0 = time.perf_counter()
        try:
            client = self._client or httpx.Client(timeout=self.timeout_s)
            try:
                res = client.post(f"{self.base_url}/v1/messages", json=self.build_body(req), headers=headers)
            finally:
                if self._client is None:
                    client.close()
        except httpx.HTTPError as e:
            raise ProviderError(self.name, None, str(e)) from e
        try:
            data: Any = res.json()
        except ValueError:
            data = {"raw": res.text}
        if res.status_code >= 400:
            msg = (data.get("error") or {}).get("message") if isinstance(data, dict) and isinstance(data.get("error"), dict) else None
            raise ProviderError(self.name, res.status_code, msg or res.text[:300], data)
        blocks = data.get("content") or []
        usage = data.get("usage") or {}
        return CompletionResult(
            text="".join(b.get("text", "") for b in blocks if b.get("type") == "text"),
            tool_calls=[ToolCall(id=b.get("id", ""), name=b.get("name", ""), arguments=json.dumps(b.get("input", {}))) for b in blocks if b.get("type") == "tool_use"],
            finish_reason=data.get("stop_reason") or "unknown",
            input_tokens=int(usage.get("input_tokens") or 0),
            output_tokens=int(usage.get("output_tokens") or 0),
            served_model=data.get("model") or req.model,
            latency_ms=round((time.perf_counter() - t0) * 1000),
            raw=data,
        )
