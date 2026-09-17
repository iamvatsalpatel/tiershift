"""Public types. Field names match the TypeScript package (src/types.ts) so logs and configs interoperate."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal, Optional, TypedDict

Role = Literal["system", "user", "assistant", "tool"]


class Message(TypedDict, total=False):
    role: Role
    content: str
    name: str


class ToolDef(TypedDict, total=False):
    name: str
    description: str
    parameters: Any


@dataclass
class Signals:
    """Jev signals. Scores are 0-2 expected values. Nouls are 0-1 probabilities."""

    difficulty: float
    difficulty_confidence: float
    needs_reasoning: float
    stakes: float
    stakes_confidence: float
    domain: str
    domain_confidence: float
    has_code: float
    ambiguous: float
    output_length: float
    creative: float
    safety_sensitive: float
    trivial_ack: float

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Signals":
        return cls(**{k: d[k] for k in cls.__dataclass_fields__})


@dataclass
class CodeSignals:
    """Free signals computed in code."""

    est_input_tokens: int
    has_tools: bool
    tool_count: int
    step: Optional[str]
    retries: int
    turn_count: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "CodeSignals":
        return cls(**{k: d[k] for k in cls.__dataclass_fields__})


class Price(TypedDict):
    input: float
    output: float


class ModelMeta(TypedDict, total=False):
    price: Price
    context: int
    max_output: int
    caps: list[str]
    params: dict[str, Any]
    release_date: str


class ProviderConfig(TypedDict, total=False):
    type: Literal["openai-compatible", "anthropic"]
    base_url: str
    api_key_env: str
    models_dev: Any


class Rule(TypedDict, total=False):
    when: str
    tier: str
    default: str


class Override(TypedDict, total=False):
    when: str
    at_least: str
    up: int


class Config(TypedDict, total=False):
    providers: dict[str, ProviderConfig]
    tiers: dict[str, list[str]]
    rules: list[Rule]
    overrides: list[Override]
    models: dict[str, ModelMeta]
    budget: dict[str, Any]
    fallback: Literal["up", "none"]
    defaults: dict[str, Any]
    log: dict[str, Any]
    degrade: bool
    jev: dict[str, Any]


@dataclass
class Decision:
    model: str
    provider: str
    tier: str
    tier_index: int
    requested_tier: str
    degraded: bool
    fallback: Optional[str]
    signals: Signals
    code_signals: CodeSignals
    confidence: float
    reason: list[str]
    est_cost_usd: Optional[float]
    est_output_tokens: int
    jev_latency_ms: int
    jev_input_tokens: int

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str


@dataclass
class Attempt:
    model: str
    ok: bool
    latency_ms: int
    error: Optional[str] = None
    status: Optional[int] = None


@dataclass
class CompleteResult:
    decision: Decision
    model: str
    served_model: str
    fell_back: bool
    attempts: list[Attempt]
    text: str
    tool_calls: list[ToolCall]
    finish_reason: str
    usage: dict[str, int]
    cost_usd: Optional[float]
    latency_ms: int
    raw: Any = field(repr=False, default=None)
