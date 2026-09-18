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
    mid_tier_ok: float
    """Probability that a competent mid-tier model would answer well without expert-level reasoning."""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Signals":
        return cls(**{k: d[k] for k in cls.__dataclass_fields__})


# Every signal name a policy condition may reference. One source of truth for policy.py and config.py. Mirrors src/types.ts.
KNOWN_SIGNALS: tuple[str, ...] = (
    # Jev signals
    "difficulty", "difficulty_confidence", "needs_reasoning", "stakes", "stakes_confidence", "domain", "domain_confidence",
    "has_code", "ambiguous", "output_length", "creative", "safety_sensitive", "trivial_ack", "mid_tier_ok",
    # code signals
    "est_input_tokens", "has_tools", "tool_count", "step", "retries", "turn_count",
    # policy state
    "tier",
)

# Pinned Jev version. Routing decisions depend on the model, so upgrades are deliberate: set `jev.model` in the YAML.
DEFAULT_JEV_MODEL = "jev-1.13.0"


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
    """Raise to this tier when the current tier is lower."""
    at_most: str
    """Lower to this tier when the current tier is higher. Mirror of `at_least`."""
    up: int
    """Move up this many tiers, capped at the top."""


class GateConfig(TypedDict, total=False):
    enabled: bool
    threshold: float
    tiers: list[str]


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
    gate: GateConfig
    """Answer gate: after an answer from a listed tier, one Jev call checks it addresses the request; below `threshold`, retry one tier up. Off by default."""


@dataclass
class Decision:
    model: str
    provider: str
    tier: str
    tier_index: int
    requested_tier: str
    degraded: bool
    fallback: Optional[str]
    fallback_tier: Optional[str]
    """Tier the fallback model was picked from. None when there is no fallback."""
    signals: Signals
    code_signals: CodeSignals
    confidence: float
    reason: list[str]
    est_cost_usd: Optional[float]
    est_flagship_cost_usd: Optional[float]
    """What the same request would cost on the first usable model of the top tier. None when unpriced."""
    est_flagship_model: Optional[str]
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
class GateResult:
    addresses: float
    """P(the answer fully addresses the request), from Jev."""
    threshold: float
    passed: bool
    latency_ms: int
    jev_input_tokens: int


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
    """Cost of the answer that was served. None when the price is unknown."""
    total_cost_usd: Optional[float]
    """Everything billed for this request: failed attempts, gate calls, and the served answer. This is what the log records."""
    gate: Optional[GateResult]
    """Answer-gate result for the served answer, or None when the gate did not run."""
    latency_ms: int
    raw: Any = field(repr=False, default=None)
