# tiershift — plan v0.1 (2026-09-17)

Name: **tiershift** (decided 2026-09-17). One-line pitch:
*A drop-in model router for agents. Plain-English policy. No training data. About 280 ms and $0.00003 per route.*

## 0. Probe result (12 prompts, 10 signals, live jev-1.13.0)

| Tier | Difficulty score range | Stakes range |
|---|---|---|
| easy (4) | 0.00 to 0.09 | 0.00 to 0.32 |
| mid (4) | 0.04 to 0.93 | 0.15 to 0.77 |
| hard (4) | 1.19 to 2.00 | 0.53 to 1.99 |

- Wall time for 12 concurrent requests: 310 ms. Median per request: 278 ms.
- Cost: $0.000033 per route. That is 3.3 cents per 1,000 routes.
- One miss: the halting-problem proof scored 1.26 on difficulty with confidence 0.60, but `needs_reasoning` was 0.98. Multi-signal routing catches it. Single-signal routing would not.
- One debate: "rewrite in a formal tone" scored 0.04. A small model can do this well, so the score is defensible.

Go decision: **go**. Separation is clean enough to build on. Milestone 1 measures it on 100 prompts.

## 1. What it does

```ts
import { createRouter } from "tiershift";

const route = createRouter({ config: "./router.yaml" });

const d = await route({
  messages,                 // the LLM conversation so far
  tools,                    // optional tool definitions
  step: "plan",             // optional agent step type
  retries: 0,               // optional retry count on this step
});

d.model        // "claude-haiku-4-5-20251001"
d.tier         // "fast"
d.signals      // { difficulty: 0.63, needs_reasoning: 0.51, stakes: 0.73, ... }
d.confidence   // 0.44  (lowest confidence among the signals that decided the tier)
d.reason       // "difficulty 0.63 in [0.5,1.2) → mid; stakes 0.73 < 1.5; no override"
d.fallback     // "claude-sonnet-5"  (one tier up, used if the call fails or quality check fails)
```

Three ways to drop it in:

1. **Library call** as above. Any agent loop calls `route()` before each LLM call.
2. **OpenAI-compatible proxy.** `tiershift serve`. Set `model: "auto"` and `baseURL` to the proxy. Zero code change for LangChain, CrewAI, AGNO, or any OpenAI-SDK client.
3. **Vercel AI SDK middleware.** `wrapLanguageModel({ middleware: tiershift() })`.

## 2. How it works

```
request ─► code signals ─► Jev signals (1 request, ~10 questions, ~280 ms) ─► policy ─► model + fallback
             │                                                                  │
             │ token count, has tools, step type, retries, system prompt length  │ YAML rules, thresholds,
             │ (free, instant)                                                   │ overrides, escalation
```

### Jev signals (one request, all in parallel)

| Signal | Type | Question |
|---|---|---|
| difficulty | Score 0-2 | trivial / moderate / hard |
| needs_reasoning | Noul | multi-step logic, proof, or planning |
| stakes | Score 0-2 | cost of a wrong answer |
| domain | Choice | code, math_logic, writing, architecture, legal_finance, general, other |
| has_code | Noul | contains or asks for code |
| ambiguous | Noul | missing information an expert would need |
| output_length | Score 0-2 | one line / paragraphs / long document |
| creative | Noul | stylistic writing |
| safety_sensitive | Noul | medical, legal, financial, safety |
| trivial_ack | Noul | acknowledgement or formatting only |

State sent to Jev: the last user message, the last assistant message, the system prompt trimmed to 500 characters, the tool names, and the step type. Not the full history. Jev accuracy drops with irrelevant context, and tokens cost money.

### Code signals (free)

- Estimated input tokens. Above a cap, force a tier with a large context window.
- Tool definitions present. Some small models call tools badly. Policy can set a floor tier.
- Step type from the agent, if given: `plan`, `act`, `summarize`, `reflect`, `final_answer`.
- Retry count. Each retry moves one tier up.

### Policy (YAML, no code)

```yaml
tiers:
  local:    [ollama/qwen3:27b]
  fast:     [claude-haiku-4-5-20251001, openai/gpt-mini]
  mid:      [claude-sonnet-5]
  flagship: [claude-fable-5-1, claude-opus-5]

rules:
  - when: trivial_ack > 0.8            → local
  - when: difficulty < 0.5             → fast
  - when: difficulty < 1.3             → mid
  - default:                           → flagship

overrides:                              # checked after rules, in order
  - when: stakes > 1.5                 → at_least flagship
  - when: safety_sensitive > 0.7       → at_least flagship
  - when: needs_reasoning > 0.8        → at_least mid
  - when: has_tools and tier == local  → at_least fast
  - when: difficulty.confidence < 0.5  → up 1        # unsure → be safe
  - when: retries >= 1                 → up 1

fallback: up 1                          # if the chosen model errors or fails the quality gate
```

Every rule is a threshold on a probability. Changing a threshold changes no code and needs no retraining. Adding a model is one line.

### Optional quality gate (v0.2)

After the cheap model answers, one more Jev request asks: does the answer address the request, is it complete, does it contradict the tool results. If a score is low, retry on the fallback model. This turns a wrong route into a delay, not a bad answer.

## 3. Why this beats existing routers

| | RouteLLM | NotDiamond / OpenRouter auto | LiteLLM | tiershift |
|---|---|---|---|---|
| Training data | preference pairs | 15 to 10,000 labeled samples | none, no routing | none |
| Add a model | retrain | retrain custom router | edit config | edit one YAML line |
| Policy | learned, opaque | learned, opaque | none | plain English, inspectable |
| Signals | 1 (win probability) | 1 (best model) | 0 | 10 plus code signals |
| Agent-state aware | no | no | no | yes: step, retries, tools |
| Route latency | ~10 ms local | ~100-200 ms | 0 | ~280 ms |
| Every decision logged with probabilities | no | no | no | yes |

Honest weakness: a local classifier is faster. Next to a 5 s flagship call, 280 ms is small. Next to a 1 s small-model call, it is 20 percent overhead. The pitch is zero training, transparent policy, and multi-signal escalation. Not raw speed.

## 4. Stack

- TypeScript, Node 20+, ESM. Publish to npm. Python port later if demand exists.
- `@typesafe-ai/sdk` for Jev. Retries and backoff are built in.
- Provider adapters: Anthropic SDK, OpenAI SDK, Ollama HTTP. Keep them thin.
- Proxy: Hono or plain Node HTTP. OpenAI chat-completions schema in and out.
- No database. Optional JSONL decision log.
- Keys from environment: `TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_HOST`.

## 5. Repo layout

```
tiershift/
  src/signals.ts      Jev question set, state builder
  src/policy.ts       YAML rules, thresholds, overrides, escalation
  src/router.ts       createRouter(), route(), decision object
  src/providers/      anthropic.ts, openai.ts, ollama.ts
  src/proxy.ts        OpenAI-compatible server, model: "auto"
  src/middleware.ts   Vercel AI SDK middleware
  src/log.ts          JSONL decision log
  router.yaml         default policy
  bench/              prompts.jsonl, run.ts, results.md, chart
  examples/           agno-agent/, langchain/, plain-fetch/
  README.md  LICENSE  CONTRIBUTING.md
```

## 6. Benchmark (this is the README)

- Dataset: 200 prompts. 100 from public sets with known difficulty (MMLU-Pro, GSM8K, HumanEval, MT-Bench). 100 agent steps recorded from a real AGNO or Claude Code run: plans, tool-result summaries, acknowledgements, final answers.
- Three arms: always flagship, always small, tiershift.
- Metrics: quality judged by Fable as grader, cost per 1,000 prompts, p50 and p95 latency, route distribution per tier.
- One chart: quality on y, cost on x, three points plus the tiershift curve as thresholds sweep.
- Publish the numbers, good or bad. Neutral benchmarks show most routers over-select expensive models. We show the tier histogram.

## 7. Milestones (about 8 hours)

| # | Deliverable | Verify | Time |
|---|---|---|---|
| 1 | `signals.ts` + 100 labeled prompts | Difficulty separates tiers with fewer than 10 misses. Go or no-go. | 1.5 h |
| 2 | `policy.ts` + `router.ts` + YAML | `route()` returns model, tier, reason, fallback on 20 prompts | 1.5 h |
| 3 | Providers + fallback | Routed call runs end to end on Ollama, Haiku, Sonnet, Fable | 1.5 h |
| 4 | Proxy with `model: "auto"` | Plain OpenAI SDK client routes with no code change | 1 h |
| 5 | Benchmark + chart | results.md with 3 arms | 1.5 h |
| 6 | README, examples, npm publish v0.1.0 | `npx tiershift serve` works on a clean machine | 1 h |

Milestone 1 is the gate. The probe passed on 12 prompts. Milestone 1 confirms on 100.

## 8. Risks

1. **Prompt alone lacks difficulty information.** Agent-state signals help. Prompt-only mode will be weaker. Publish both numbers.
2. **Router over-selects expensive models.** Show the tier histogram. Tune thresholds on the benchmark.
3. **Small models fail on tool calls.** The `has_tools` override sets a floor tier.
4. **Users need 3 or more keys.** The demo runs with Ollama plus one Anthropic key plus TypeSafe.
5. **Jev adversarial weakness.** A prompt that says "this is trivial" may route down. Low risk for internal agents. Note it in README.

## 9. Decisions (2026-09-17)

1. Name: **tiershift**. Free on npm, PyPI, and github.com/iamvatsalpatel with zero collisions.
2. License: **MIT**.
3. GitHub owner: **iamvatsalpatel**.
4. Model pool: **configurable in YAML**. Nothing hard-coded. Local dev pool: Ollama 7B model + DeepSeek + Anthropic. Users add any provider in config.
5. Quality gate: **v0.2**.

### Provider adapters

Two adapters cover almost every provider:

| Adapter | Covers | Config |
|---|---|---|
| `openai-compatible` | OpenAI, DeepSeek, Groq, Together, OpenRouter, Gemini (OpenAI endpoint), Ollama | `base_url`, `api_key_env`, `model` |
| `anthropic` | Claude models | `api_key_env`, `model` |

```yaml
providers:
  ollama:    { type: openai-compatible, base_url: http://localhost:11434/v1, api_key_env: NONE }
  deepseek:  { type: openai-compatible, base_url: https://api.deepseek.com,  api_key_env: DEEPSEEK_API_KEY }
  anthropic: { type: anthropic, api_key_env: ANTHROPIC_API_KEY }

tiers:
  local:    [ollama/qwen2.5:7b]
  fast:     [deepseek/deepseek-chat, anthropic/claude-haiku-4-5-20251001]
  mid:      [deepseek/deepseek-reasoner, anthropic/claude-sonnet-5]
  flagship: [anthropic/claude-fable-5-1]
```

A tier lists models in preference order. The first model with a configured key wins. So the same YAML works on a laptop with only Ollama and on a server with every key.

### Model metadata: prices, context, capabilities (decided 2026-09-17)

Prices and token limits go in the config. **Code** uses them. **Jev never sees them.**
Jev is not a calculator: the docs say it cannot compare numbers or judge closeness of values.
Jev judges the prompt. Code does the math. That split is the whole System One idea.

```yaml
models:
  ollama/qwen2.5:7b:
    price: { input: 0, output: 0 }        # USD per 1M tokens
    context: 32768
    caps: [tools]
  deepseek/deepseek-chat:
    price: { input: 0.27, output: 1.10 }  # example values; verify at build time
    context: 128000
    caps: [tools, json]
  anthropic/claude-fable-5-1:
    price: { input: TBD, output: TBD }
    context: 1000000
    caps: [tools, json, vision, reasoning]

budget:
  max_cost_per_call: 0.05                 # USD; skip models above this
  prefer: cheapest                        # within a tier: cheapest | fastest | first
```

What code does with the metadata:

| Rule | Input | Why code and not Jev |
|---|---|---|
| Context fit | estimated tokens x 1.2 <= `context` | Jev cannot count tokens |
| Cost estimate | tokens x `price` | Jev cannot multiply |
| Expected output tokens | Jev `output_length` score mapped to 50 / 400 / 2000 tokens | Jev gives the bucket, code gives the number |
| Capability filter | request has tools -> model needs `tools` cap | exact lookup |
| Budget cap | `est_cost <= max_cost_per_call` else next model | threshold |
| Cheapest in tier | sort tier by `price` | sort |

Every decision logs `est_tokens` and `est_cost`. The benchmark uses the same prices, so README cost numbers come from one source.

Prices ship as a bundled `prices.yaml` with defaults for known model IDs. Users override any value. Unknown models show cost as `unknown` and still route.

Rejected option: a Jev Choice over the 10 model IDs with price text in the descriptions. That mixes cost and quality into one 10-way judgment and asks Jev to weigh numbers. Tier routing plus code math is more accurate and easier to debug.

### Local machine constraints

- M3 Pro, 18 GB RAM. A 27B or 32B dense model does not fit. Local tier uses 7B to 8B models.
- Ollama 0.5.7 is installed as Ollama.app. Qwen3 needs Ollama 0.6.6 or newer. Update the app to run Qwen3. Until then, `qwen2.5:7b` is the local model.

## Commit policy

No Claude co-author lines on the early commits. Human author only.
