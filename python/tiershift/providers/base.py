"""Minimal provider interface."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, Sequence

from ..types import Message, ToolCall, ToolDef


@dataclass
class CompletionRequest:
    model: str
    messages: Sequence[Message]
    tools: Optional[Sequence[ToolDef]] = None
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None
    params: Optional[dict[str, Any]] = None
    """Provider-specific fields merged into the request body. From `models.<id>.params` in the config."""


@dataclass
class CompletionResult:
    text: str
    tool_calls: list[ToolCall]
    finish_reason: str
    input_tokens: int
    output_tokens: int
    served_model: str
    latency_ms: int
    raw: Any = field(repr=False, default=None)


class ProviderError(Exception):
    def __init__(self, provider: str, status: Optional[int], message: str, body: Any = None) -> None:
        super().__init__(f"{provider}: {message}")
        self.provider = provider
        self.status = status
        self.body = body

    @property
    def retryable(self) -> bool:
        """408, 409, 429, and 5xx are worth a retry on the fallback model. 4xx validation errors are not."""
        return self.status is None or self.status in (408, 409, 429) or self.status >= 500


class Provider(Protocol):
    name: str

    def complete(self, req: CompletionRequest) -> CompletionResult: ...
