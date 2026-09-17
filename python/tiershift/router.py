"""create_router(): Jev signals → policy → model selection with budget, context, and capability checks. Port of src/router.ts."""

from __future__ import annotations

import os
import time
from typing import Any, Mapping, Optional, Sequence, Union

from typesafe_sdk import TypeSafeClient

from .config import has_key, load_config, split_model
from .log import DEFAULT_LOG, from_decision, log_entry
from .policy import apply_policy, estimate_output_tokens
from .providers import CompletionRequest, Provider, ProviderError, build_providers
from .signals import ask_jev, build_state, code_signals
from .types import DEFAULT_JEV_MODEL, Attempt, CompleteResult, Config, Decision, Message, ModelMeta, ToolDef

Pick = tuple[str, Optional[float]]


def _est_cost(meta: Optional[ModelMeta], in_tok: int, out_tok: int) -> Optional[float]:
    if not meta or "price" not in meta:
        return None
    return (in_tok * meta["price"]["input"] + out_tok * meta["price"]["output"]) / 1_000_000


def _pick_in_tier(cfg: Config, tier: str, in_tok: int, out_tok: int, need_tools: bool, max_cost: Optional[float], env: Mapping[str, str], reason: list[str]) -> Optional[Pick]:
    """Pick the first model in a tier that fits context, capabilities, key, and budget. None when nothing fits."""
    models = cfg.get("models") or {}
    candidates = [m for m in cfg["tiers"].get(tier, []) if has_key(cfg, split_model(m)[0], env)]
    if (cfg.get("budget") or {}).get("prefer") == "cheapest":
        candidates.sort(key=lambda m: (_est_cost(models.get(m), in_tok, out_tok) if _est_cost(models.get(m), in_tok, out_tok) is not None else float("inf")))
    for mid in candidates:
        meta = models.get(mid)
        if meta and meta.get("context") and in_tok * 1.2 > meta["context"]:
            reason.append(f"skip {mid}: {in_tok} tokens exceeds context {meta['context']}")
            continue
        if need_tools and meta and meta.get("caps") is not None and "tools" not in meta["caps"]:
            reason.append(f"skip {mid}: no tools capability")
            continue
        cost = _est_cost(meta, in_tok, out_tok)
        if max_cost is not None and cost is not None and cost > max_cost:
            reason.append(f"skip {mid}: est ${cost:.4f} > budget ${max_cost}")
            continue
        return mid, cost
    return None


class Router:
    """Decide (`route`) or decide-and-call (`complete`). Sync only in v0.1."""

    def __init__(self, config: Optional[Union[str, Config]] = None, env: Optional[Mapping[str, str]] = None, log: Union[str, bool, None] = None,
                 typesafe_api_key: Optional[str] = None, jev_client: Any = None, providers: Optional[Mapping[str, Provider]] = None) -> None:
        self.env: Mapping[str, str] = os.environ if env is None else env
        self.config: Config = config if isinstance(config, dict) else load_config(config)  # type: ignore[arg-type]
        jev_cfg = self.config.get("jev") or {}
        self._jev_model: str = jev_cfg.get("model") or DEFAULT_JEV_MODEL
        self._jev_timeout: Optional[float] = (jev_cfg["timeout_ms"] / 1000) if jev_cfg.get("timeout_ms") else None
        self._jev_override = jev_client
        self._typesafe_api_key = typesafe_api_key
        self._jev_instance: Any = None
        self.order = list(self.config["tiers"].keys())
        self.providers: dict[str, Provider] = dict(providers) if providers is not None else build_providers(self.config, self.env)
        log_cfg = self.config.get("log") or {}
        if log is False or log_cfg.get("enabled") is False:
            self.log_path: Optional[str] = None
        elif isinstance(log, str):
            self.log_path = log
        else:
            self.log_path = log_cfg.get("path") or DEFAULT_LOG
        # Every secret this router knows about. Provider errors sometimes echo request headers; never let a key reach a log or an error.
        keys = [typesafe_api_key, self.env.get("TYPESAFE_API_KEY")] + [self.env.get(p["api_key_env"]) for p in self.config["providers"].values() if p.get("api_key_env")]
        self._secrets: list[str] = [k for k in keys if isinstance(k, str) and len(k) >= 8]

    def _redact(self, text: str) -> str:
        for s in self._secrets:
            text = text.replace(s, "[redacted]")
        return text

    @property
    def _jev(self) -> Any:
        """Built on first use so `check`, `report`, and `tune` never need a TypeSafe key."""
        if self._jev_override is not None:
            return self._jev_override
        if self._jev_instance is None:
            key = self._typesafe_api_key or self.env.get("TYPESAFE_API_KEY")
            if not key:
                raise RuntimeError("TYPESAFE_API_KEY is not set. Routing needs a TypeSafe key; get one at typesafe.ai.")
            self._jev_instance = TypeSafeClient(api_key=key, model=self._jev_model)
        return self._jev_instance

    def _write(self, entry: dict[str, Any]) -> None:
        if not self.log_path:
            return
        try:
            log_entry(self.log_path, entry)
        except Exception:
            pass  # logging never breaks routing

    def available(self) -> dict[str, list[str]]:
        """Models whose provider has a usable key, per tier, in preference order."""
        return {t: [m for m in ms if has_key(self.config, split_model(m)[0], self.env)] for t, ms in self.config["tiers"].items()}

    def route(self, messages: Sequence[Message], tools: Optional[Sequence[ToolDef]] = None, step: Optional[str] = None, retries: int = 0,
              max_cost: Optional[float] = None, tag: Optional[str] = None, _no_log: bool = False) -> Decision:
        cfg = self.config
        code = code_signals(messages, tools, step, retries)
        jev = ask_jev(self._jev, build_state(messages, tools, step, retries), self._jev_model, self._jev_timeout)
        policy = apply_policy(cfg, jev.signals, code)
        out_tok = estimate_output_tokens(jev.signals.output_length)
        budget = cfg.get("budget") or {}
        mc = max_cost if max_cost is not None else budget.get("max_cost_per_call")
        reason = list(policy.reason)
        order = self.order

        # Walk up from the chosen tier until a model fits. Never walk down: a cheaper tier was already judged insufficient.
        ti = policy.tier_index
        pick: Optional[Pick] = None
        while ti < len(order) and pick is None:
            pick = _pick_in_tier(cfg, order[ti], code.est_input_tokens, out_tok, code.has_tools, mc, self.env, reason)
            if pick is None:
                reason.append(f"no usable model in tier {order[ti]}")
                ti += 1
        if pick is not None and ti != policy.tier_index:
            reason.append(f"walked up to {order[ti]}")

        # Last resort: nothing at or above the chosen tier has a key. Degrade to the best available model below and say so.
        degraded = False
        if pick is None and cfg.get("degrade", True) is not False:
            ti = policy.tier_index - 1
            while ti >= 0 and pick is None:
                pick = _pick_in_tier(cfg, order[ti], code.est_input_tokens, out_tok, code.has_tools, mc, self.env, reason)
                if pick is None:
                    ti -= 1
            if pick is not None:
                degraded = True
                reason.append(f"DEGRADED: no usable model in {policy.tier} or above, using {order[ti]}")
        if pick is None:
            raise RuntimeError(f"No model fits. Check provider keys and budget. Reasons: {'; '.join(reason)}")

        fallback: Optional[str] = None
        if cfg.get("fallback", "up") != "none":
            for fi in range(ti + 1, len(order)):
                fb = _pick_in_tier(cfg, order[fi], code.est_input_tokens, out_tok, code.has_tools, None, self.env, [])
                if fb is not None:
                    fallback = fb[0]
                    break

        deciding_conf = min(jev.signals.difficulty_confidence, jev.signals.stakes_confidence)
        decision = Decision(
            model=pick[0], provider=split_model(pick[0])[0], tier=order[ti], tier_index=ti, requested_tier=policy.tier, degraded=degraded,
            fallback=fallback, signals=jev.signals, code_signals=code, confidence=round(deciding_conf, 3), reason=reason,
            est_cost_usd=pick[1], est_output_tokens=out_tok, jev_latency_ms=jev.latency_ms, jev_input_tokens=jev.input_tokens,
        )
        if not _no_log:
            self._write(from_decision(decision, "route", tag=tag))
        return decision

    def _tier_of(self, model_id: str) -> str:
        for t, ms in self.config["tiers"].items():
            if model_id in ms:
                return t
        return self.order[0]

    def complete(self, messages: Sequence[Message], tools: Optional[Sequence[ToolDef]] = None, step: Optional[str] = None, retries: int = 0,
                 max_cost: Optional[float] = None, tag: Optional[str] = None, max_tokens: Optional[int] = None, temperature: Optional[float] = None) -> CompleteResult:
        """Decide, call the model, and fall back one tier up on a retryable failure. 4xx validation errors do not fall back."""
        cfg = self.config
        decision = self.route(messages, tools, step, retries, max_cost, tag, _no_log=True)
        candidates = [m for m in (decision.model, decision.fallback) if m]
        attempts: list[Attempt] = []
        defaults = cfg.get("defaults") or {}
        models = cfg.get("models") or {}
        min_out = defaults.get("min_output_tokens", 1024)
        for mid in candidates:
            pname, model = split_model(mid)
            provider = self.providers.get(pname)
            t0 = time.perf_counter()
            if provider is None:
                attempts.append(Attempt(model=mid, ok=False, latency_ms=0, error=f'provider "{pname}" has no key', status=None))
                continue
            # Reasoning models spend output tokens on thinking first. A small budget returns an empty answer at full price.
            mt = max_tokens or defaults.get("max_tokens") or 4096
            if "reasoning" in ((models.get(mid) or {}).get("caps") or []) and mt < min_out:
                decision.reason.append(f"raised max_tokens to {min_out} for reasoning model {mid}")
                mt = min_out
            try:
                r = provider.complete(CompletionRequest(
                    model=model, messages=messages, tools=tools, max_tokens=mt,
                    temperature=temperature if temperature is not None else defaults.get("temperature"),
                    params=(models.get(mid) or {}).get("params"),
                ))
                if not r.text.strip() and not r.tool_calls and r.finish_reason == "length":
                    raise ProviderError(pname, None, f"empty_answer:length (output budget {mt} consumed before any answer text; {r.output_tokens} output tokens billed)")
            except ProviderError as e:
                attempts.append(Attempt(model=mid, ok=False, latency_ms=round((time.perf_counter() - t0) * 1000), error=self._redact(str(e)), status=e.status))
                if not e.retryable:
                    break
                continue
            except Exception as e:  # network or unexpected: try the fallback
                attempts.append(Attempt(model=mid, ok=False, latency_ms=round((time.perf_counter() - t0) * 1000), error=self._redact(str(e))))
                continue
            attempts.append(Attempt(model=mid, ok=True, latency_ms=r.latency_ms))
            cost = _est_cost(models.get(mid), r.input_tokens, r.output_tokens)
            fell_back = mid != decision.model
            self._write(from_decision(decision, "complete", model=mid, tier=self._tier_of(mid), fell_back=fell_back, cost_usd=cost,
                                      input_tokens=r.input_tokens, output_tokens=r.output_tokens, model_latency_ms=r.latency_ms, tag=tag))
            return CompleteResult(
                decision=decision, model=mid, served_model=r.served_model, fell_back=fell_back, attempts=attempts, text=r.text,
                tool_calls=r.tool_calls, finish_reason=r.finish_reason, usage={"input_tokens": r.input_tokens, "output_tokens": r.output_tokens},
                cost_usd=cost, latency_ms=r.latency_ms, raw=r.raw,
            )
        raise RuntimeError(self._redact("tiershift: every candidate failed. " + " | ".join(f"{a.model}: {a.error}" for a in attempts)))


def create_router(config: Optional[Union[str, Config]] = None, env: Optional[Mapping[str, str]] = None, log: Union[str, bool, None] = None, **kwargs: Any) -> Router:
    """Build a Router. `config` is a path or a dict; defaults to ./tiershift.yaml, then the bundled default."""
    return Router(config=config, env=env, log=log, **kwargs)
