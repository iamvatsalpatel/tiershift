/** Build the Jev state and question set, call Jev, return typed signals. */
import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";
import type { CodeSignals, Message, RouteInput, Signals, ToolDef } from "./types.js";

const SYSTEM_PROMPT_CHARS = 500;
const MESSAGE_CHARS = 4000;

/** Questions are the routing brain. Instructions name the state fields they judge. */
export const QUESTIONS = {
  difficulty: score(
    "How hard is it to answer `request.user_message` well? Consider `request.system_prompt` and `request.step` for context.",
    [
      "trivial: a lookup, a formatting change, an acknowledgement, or a one-line reply",
      "moderate: needs domain knowledge or a few reasoning steps; a competent generalist can do it",
      "hard: needs deep expertise, long multi-step reasoning, careful trade-off analysis, or novel design",
    ],
  ),
  needs_reasoning: noul(
    "Does `request.user_message` require multi-step logical reasoning, proof, debugging, or planning rather than recall, rewriting, or formatting?",
  ),
  stakes: score(
    "How costly is a wrong or low-quality answer to `request.user_message` for the user?",
    [
      "low: easy to spot and redo; no external consequence",
      "medium: wastes real time or money if wrong; affects work product",
      "high: legal, financial, medical, safety, security, or production-system impact",
    ],
  ),
  domain: choice("Which domain does `request.user_message` belong to?", {
    code: "writing, debugging, reviewing, or explaining software",
    math_logic: "mathematics, proofs, formal logic, puzzles",
    writing: "prose, tone, editing, summarizing, translation",
    architecture: "system design, infrastructure, migrations, planning",
    legal_finance: "contracts, compliance, money, tax",
    data: "data analysis, SQL, spreadsheets, statistics",
    general: "general knowledge, conversation, simple questions",
    other: null,
  }),
  has_code: noul("Does `request.user_message` contain code or ask for code to be written, fixed, or reviewed?"),
  ambiguous: noul("Is `request.user_message` missing information that an expert would need before answering well?"),
  output_length: score("How long should a good answer to `request.user_message` be?", [
    "one line or a single value",
    "one to three paragraphs or a short code snippet",
    "a long document, a detailed plan, or multi-file code",
  ]),
  creative: noul("Does `request.user_message` ask for creative or stylistic writing rather than factual or technical output?"),
  safety_sensitive: noul(
    "Does `request.user_message` ask for medical, legal, financial, or physical-safety advice where an error could harm someone?",
  ),
  trivial_ack: noul(
    "Is `request.user_message` a trivial acknowledgement, confirmation, greeting, or pure formatting request that needs no thought?",
  ),
} as const;

export interface JevResult {
  signals: Signals;
  latency_ms: number;
  input_tokens: number;
}

/** Trim the conversation to what Jev needs. Jev accuracy drops with irrelevant context. */
export function buildState(input: RouteInput) {
  const msgs = input.messages;
  const system = msgs.find((m) => m.role === "system")?.content ?? "";
  const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
  const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant")?.content ?? "";
  const lastTool = [...msgs].reverse().find((m) => m.role === "tool")?.content ?? "";
  return {
    request: {
      system_prompt: system.slice(0, SYSTEM_PROMPT_CHARS),
      user_message: lastUser.slice(0, MESSAGE_CHARS),
      previous_assistant_message: lastAssistant.slice(0, 1000),
      last_tool_result: lastTool.slice(0, 1000),
      tool_names: (input.tools ?? []).map((t) => t.name),
      step: input.step ?? null,
      retries: input.retries ?? 0,
    },
  };
}

/** Rough token estimate. Four characters per token. Good enough for budget and context checks. */
export function estimateTokens(messages: Message[], tools?: ToolDef[]): number {
  const text = messages.map((m) => m.content).join("\n") + JSON.stringify(tools ?? []);
  return Math.ceil(text.length / 4);
}

export function codeSignals(input: RouteInput): CodeSignals {
  const tools = input.tools ?? [];
  return {
    est_input_tokens: estimateTokens(input.messages, tools),
    has_tools: tools.length > 0,
    tool_count: tools.length,
    step: input.step ?? null,
    retries: input.retries ?? 0,
    turn_count: input.messages.filter((m) => m.role === "user").length,
  };
}

export async function askJev(client: TypeSafeClient, input: RouteInput, model?: string, timeout?: number): Promise<JevResult> {
  const t0 = performance.now();
  const res = await client.systemOne({ state: buildState(input), questions: QUESTIONS, model }, { timeout });
  const a = res.answers;
  return {
    signals: {
      difficulty: a.difficulty.score,
      difficulty_confidence: a.difficulty.confidence,
      needs_reasoning: a.needs_reasoning.noul,
      stakes: a.stakes.score,
      stakes_confidence: a.stakes.confidence,
      domain: a.domain.choice,
      domain_confidence: a.domain.confidence,
      has_code: a.has_code.noul,
      ambiguous: a.ambiguous.noul,
      output_length: a.output_length.score,
      creative: a.creative.noul,
      safety_sensitive: a.safety_sensitive.noul,
      trivial_ack: a.trivial_ack.noul,
    },
    latency_ms: Math.round(performance.now() - t0),
    input_tokens: res.usage.input_tokens,
  };
}
