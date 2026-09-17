"""Build the Jev state and question set, call Jev, return typed signals. Port of src/signals.ts."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Optional, Sequence

from typesafe_sdk import AsyncTypeSafeClient, Choice, Noul, Score, TypeSafeClient

from .types import CodeSignals, Message, Signals, ToolDef

SYSTEM_PROMPT_CHARS = 500
MESSAGE_CHARS = 4000

# Questions are the routing brain. Same text as the TypeScript package so both route identically.
QUESTIONS: dict[str, Any] = {
    "difficulty": Score(
        instructions="How hard is it to answer `request.user_message` well? Consider `request.system_prompt` and `request.step` for context.",
        criteria=[
            "trivial: a lookup, a formatting change, an acknowledgement, or a one-line reply",
            "moderate: needs domain knowledge or a few reasoning steps; a competent generalist can do it",
            "hard: needs deep expertise, long multi-step reasoning, careful trade-off analysis, or novel design",
        ],
    ),
    "needs_reasoning": Noul(
        instructions="Does `request.user_message` require multi-step logical reasoning, proof, debugging, or planning rather than recall, rewriting, or formatting?",
    ),
    "stakes": Score(
        instructions="How costly is a wrong or low-quality answer to `request.user_message` for the user?",
        criteria=[
            "low: easy to spot and redo; no external consequence",
            "medium: wastes real time or money if wrong; affects work product",
            "high: legal, financial, medical, safety, security, or production-system impact",
        ],
    ),
    "domain": Choice(
        instructions="Which domain does `request.user_message` belong to?",
        criteria={
            "code": "writing, debugging, reviewing, or explaining software",
            "math_logic": "mathematics, proofs, formal logic, puzzles",
            "writing": "prose, tone, editing, summarizing, translation",
            "architecture": "system design, infrastructure, migrations, planning",
            "legal_finance": "contracts, compliance, money, tax",
            "data": "data analysis, SQL, spreadsheets, statistics",
            "general": "general knowledge, conversation, simple questions",
            "other": None,
        },
    ),
    "has_code": Noul(instructions="Does `request.user_message` contain code or ask for code to be written, fixed, or reviewed?"),
    "ambiguous": Noul(instructions="Is `request.user_message` missing information that an expert would need before answering well?"),
    "output_length": Score(
        instructions="How long should a good answer to `request.user_message` be?",
        criteria=[
            "one line or a single value",
            "one to three paragraphs or a short code snippet",
            "a long document, a detailed plan, or multi-file code",
        ],
    ),
    "creative": Noul(instructions="Does `request.user_message` ask for creative or stylistic writing rather than factual or technical output?"),
    "safety_sensitive": Noul(
        instructions="Does `request.user_message` ask for medical, legal, financial, or physical-safety advice where an error could harm someone?",
    ),
    "trivial_ack": Noul(
        instructions="Is `request.user_message` a trivial acknowledgement, confirmation, greeting, or pure formatting request that needs no thought?",
    ),
}


@dataclass
class JevResult:
    signals: Signals
    latency_ms: int
    input_tokens: int


def _last(messages: Sequence[Message], role: str) -> str:
    for m in reversed(messages):
        if m.get("role") == role:
            return m.get("content") or ""
    return ""


def build_state(messages: Sequence[Message], tools: Optional[Sequence[ToolDef]] = None, step: Optional[str] = None, retries: int = 0) -> dict[str, Any]:
    """Trim the conversation to what Jev needs. Jev accuracy drops with irrelevant context."""
    system = next((m.get("content") or "" for m in messages if m.get("role") == "system"), "")
    return {
        "request": {
            "system_prompt": system[:SYSTEM_PROMPT_CHARS],
            "user_message": _last(messages, "user")[:MESSAGE_CHARS],
            "previous_assistant_message": _last(messages, "assistant")[:1000],
            "last_tool_result": _last(messages, "tool")[:1000],
            "tool_names": [t.get("name", "") for t in (tools or [])],
            "step": step,
            "retries": retries,
        }
    }


def estimate_tokens(messages: Sequence[Message], tools: Optional[Sequence[ToolDef]] = None) -> int:
    """Rough token estimate. Four characters per token. Good enough for budget and context checks."""
    text = "\n".join(m.get("content") or "" for m in messages) + json.dumps(list(tools or []), separators=(",", ":"))
    return -(-len(text) // 4)


def code_signals(messages: Sequence[Message], tools: Optional[Sequence[ToolDef]] = None, step: Optional[str] = None, retries: int = 0) -> CodeSignals:
    tl = list(tools or [])
    return CodeSignals(
        est_input_tokens=estimate_tokens(messages, tl),
        has_tools=len(tl) > 0,
        tool_count=len(tl),
        step=step,
        retries=retries,
        turn_count=sum(1 for m in messages if m.get("role") == "user"),
    )


def _to_signals(answers: dict[str, Any]) -> Signals:
    a = answers
    return Signals(
        difficulty=a["difficulty"].score,
        difficulty_confidence=a["difficulty"].confidence,
        needs_reasoning=a["needs_reasoning"].noul,
        stakes=a["stakes"].score,
        stakes_confidence=a["stakes"].confidence,
        domain=a["domain"].choice,
        domain_confidence=a["domain"].confidence,
        has_code=a["has_code"].noul,
        ambiguous=a["ambiguous"].noul,
        output_length=a["output_length"].score,
        creative=a["creative"].noul,
        safety_sensitive=a["safety_sensitive"].noul,
        trivial_ack=a["trivial_ack"].noul,
    )


def ask_jev(client: TypeSafeClient, state: dict[str, Any], model: Optional[str] = None, timeout: Optional[float] = None) -> JevResult:
    t0 = time.perf_counter()
    res = client.system_one(state=state, questions=QUESTIONS, model=model, timeout=timeout)
    return JevResult(signals=_to_signals(res.answers), latency_ms=round((time.perf_counter() - t0) * 1000), input_tokens=res.usage.input_tokens or 0)


async def ask_jev_async(client: AsyncTypeSafeClient, state: dict[str, Any], model: Optional[str] = None, timeout: Optional[float] = None) -> JevResult:
    t0 = time.perf_counter()
    res = await client.system_one(state=state, questions=QUESTIONS, model=model, timeout=timeout)
    return JevResult(signals=_to_signals(res.answers), latency_ms=round((time.perf_counter() - t0) * 1000), input_tokens=res.usage.input_tokens or 0)
