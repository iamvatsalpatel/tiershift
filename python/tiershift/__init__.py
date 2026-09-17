"""tiershift: shift every LLM call to the cheapest model that can handle it. Routing decided by TypeSafe Jev."""

from .analytics import Report, TuneResult, build_report, entry_cost, est_cost_for, model_for_tier, tune
from .config import available_tiers, load_config, load_prices, merge_model_meta, split_model, validate
from .log import DEFAULT_LOG, from_decision, log_entry, read_log
from .policy import PolicyResult, apply_policy, estimate_output_tokens, eval_condition
from .providers import AnthropicProvider, OpenAICompatibleProvider, Provider, ProviderError, build_providers
from .router import Router, create_router
from .signals import QUESTIONS, ask_jev, ask_jev_async, build_state, code_signals, estimate_tokens
from .types import Attempt, CodeSignals, CompleteResult, Config, Decision, Message, ModelMeta, Signals, ToolCall, ToolDef

__version__ = "0.1.0"
__all__ = [
    "Attempt", "CodeSignals", "CompleteResult", "Config", "Decision", "Message", "ModelMeta", "Signals", "ToolCall", "ToolDef",
    "Router", "create_router", "load_config", "load_prices", "merge_model_meta", "validate", "split_model", "available_tiers",
    "apply_policy", "eval_condition", "estimate_output_tokens", "PolicyResult",
    "QUESTIONS", "build_state", "code_signals", "estimate_tokens", "ask_jev", "ask_jev_async",
    "log_entry", "read_log", "from_decision", "DEFAULT_LOG",
    "build_report", "tune", "entry_cost", "est_cost_for", "model_for_tier", "Report", "TuneResult",
    "AnthropicProvider", "OpenAICompatibleProvider", "Provider", "ProviderError", "build_providers",
]
