"""One adapter for every OpenAI-compatible chat endpoint: OpenAI, DeepSeek, Groq, Together, OpenRouter, Ollama, Gemini."""

from __future__ import annotations

import re
import time
from typing import Any, Literal, Optional

import httpx

from ..types import ToolCall
from .base import CompletionRequest, CompletionResult, ProviderError

TokenParam = Literal["max_tokens", "max_completion_tokens", "auto"]


class OpenAICompatibleProvider:
    def __init__(self, name: str, base_url: str, api_key: Optional[str] = None, token_param: TokenParam = "auto", timeout_s: float = 120.0, client: Optional[httpx.Client] = None) -> None:
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.token_param = token_param
        self.timeout_s = timeout_s
        self._client = client

    def _resolve_token_param(self) -> str:
        if self.token_param != "auto":
            return self.token_param
        # Verified 2026-09-17: api.openai.com rejects max_tokens on gpt-5.x; Ollama accepts both but is 60x slower on max_completion_tokens.
        return "max_completion_tokens" if re.search(r"api\.openai\.com", self.base_url) else "max_tokens"

    def build_body(self, req: CompletionRequest) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": req.model,
            "messages": [{"role": m["role"], "content": m.get("content", ""), **({"name": m["name"]} if m.get("name") else {})} for m in req.messages],
        }
        if req.max_tokens:
            body[self._resolve_token_param()] = req.max_tokens
        if req.temperature is not None:
            body["temperature"] = req.temperature
        if req.tools:
            body["tools"] = [{"type": "function", "function": {"name": t["name"], "description": t.get("description"), "parameters": t.get("parameters") or {"type": "object", "properties": {}}}} for t in req.tools]
        if req.params:
            body.update(req.params)
        return body

    def complete(self, req: CompletionRequest) -> CompletionResult:
        url = f"{self.base_url}/chat/completions"
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        t0 = time.perf_counter()
        try:
            client = self._client or httpx.Client(timeout=self.timeout_s)
            try:
                res = client.post(url, json=self.build_body(req), headers=headers)
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
        choice = (data.get("choices") or [{}])[0]
        msg_obj = choice.get("message") or {}
        content = msg_obj.get("content")
        return CompletionResult(
            text=content if isinstance(content, str) else "",
            tool_calls=[ToolCall(id=c.get("id", ""), name=(c.get("function") or {}).get("name", ""), arguments=(c.get("function") or {}).get("arguments", "{}")) for c in (msg_obj.get("tool_calls") or [])],
            finish_reason=choice.get("finish_reason") or "unknown",
            input_tokens=int((data.get("usage") or {}).get("prompt_tokens") or 0),
            output_tokens=int((data.get("usage") or {}).get("completion_tokens") or 0),
            served_model=data.get("model") or req.model,
            latency_ms=round((time.perf_counter() - t0) * 1000),
            raw=data,
        )
