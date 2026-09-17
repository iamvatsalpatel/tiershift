# tiershift

**Shift every LLM call to the cheapest model that can handle it.**
Routing decided by [TypeSafe Jev](https://docs.typesafe.ai) in about 300 ms for $0.00004 per call. No training data. Policy in plain YAML. Prices and limits synced from [models.dev](https://models.dev).

```
$ tiershift ask "ok thanks"
→ ollama/qwen2.5:7b   tier=local
  rule "trivial_ack > 0.8" → local

$ tiershift ask "What is the capital of France? One word."
→ deepseek/deepseek-flash   tier=fast
  rule "difficulty < 0.5" → fast

$ tiershift ask "Explain the difference between optimistic and pessimistic locking in two sentences."
→ openai/gpt-5.6-terra   tier=mid
  rule "difficulty < 1.3" → mid

$ tiershift ask "In one paragraph, review this indemnification clause for risk: Vendor shall indemnify Client against all claims arising from any cause whatsoever."
→ openai/gpt-5.6-sol   tier=flagship
  rule "difficulty < 1.3" → mid  |  override "stakes > 1.5" → at_least flagship
  jev 323 ms · model 6407 ms · 32 in / 190 out · cost $0.003928
```

Real output from one laptop session with Ollama, DeepSeek, and OpenAI keys. The legal clause was only "mid" difficulty, but stakes scored 1.99 out of 2, so an override lifted it to the flagship tier.

## Why

An agent run has ten steps. Seven are trivial: acknowledge a tool result, reformat, pick a branch. Most agents send all ten to the flagship model. tiershift sends each step to the cheapest tier that can handle it, and moves up when the stakes are high, the confidence is low, or a retry happened.

Existing routers learn a black box from labeled data and need retraining when you add a model. tiershift asks Jev ten narrow questions about the prompt, then applies rules you can read. Adding a model is one YAML line.

| | RouteLLM | NotDiamond | tiershift |
|---|---|---|---|
| Training data | preference pairs | 15 to 10,000 labels | none |
| Add a model | retrain | retrain | one YAML line |
| Policy | learned | learned | plain YAML, inspectable |
| Signals per route | 1 | 1 | 10 from Jev, plus token count, tools, step, retries |
| Every decision logged with probabilities | no | no | yes |
| Route latency | ~10 ms local | ~100 to 200 ms | ~300 ms |

Honest note: a local classifier is faster. Next to a 5-second flagship call, 300 ms is small. Next to a 1-second small-model call, it is a real overhead. The pitch is zero training, transparent policy, and multi-signal escalation.

## How it works

```
prompt ─► code signals ─► Jev: 10 questions, one call ─► YAML rules and overrides ─► model + fallback ─► provider call
          tokens, tools,     difficulty, stakes, reasoning,    thresholds on probabilities;      retry one tier up
          step, retries      domain, length, safety, ...       context, capability, budget checks   on failure
```

Jev judges meaning. Code does arithmetic. Jev never sees prices or token counts, because [Jev is not a calculator](https://docs.typesafe.ai/model-jaggedness/jev-1.13). Code checks context fit, estimates cost from `prices.yaml`, and skips models over budget.

## Install

```bash
npm install tiershift
export TYPESAFE_API_KEY=...        # get one at typesafe.ai
```

Provider keys are optional. A tier skips any model whose key is missing. With only [Ollama](https://ollama.com) running, everything routes to the local model and the decision is flagged `degraded: true`.

## Use

### Decide, then call the model yourself

```ts
import { createRouter } from "tiershift";

const router = createRouter();                  // reads ./tiershift.yaml, else the bundled default

const d = await router.route({
  messages,                                     // your conversation so far
  tools,                                        // optional tool definitions
  step: "plan",                                 // optional agent step type
  retries: 0,                                   // optional; each retry moves one tier up
});

d.model        // "deepseek/deepseek-flash"
d.tier         // "fast"
d.fallback     // "openai/gpt-5.6-terra"        use this if the call fails
d.signals      // { difficulty: 0.31, stakes: 0.12, needs_reasoning: 0.08, ... }
d.reason       // ['rule "difficulty < 0.5" → fast']
d.est_cost_usd // 0.00006
```

### Decide, call, and fall back in one step

```ts
const r = await router.complete({ messages, tools, maxTokens: 1024 });

r.text          // the answer
r.tool_calls    // [{ id, name, arguments }]
r.model         // the model that answered; differs from r.decision.model when a fallback ran
r.fell_back     // false
r.cost_usd      // actual cost from reported usage and prices.yaml
r.attempts      // [{ model, ok, latency_ms, error? }]
```

`complete()` tries the chosen model, then the fallback one tier up. Provider errors carry the HTTP status, and 4xx validation errors do not trigger a fallback.

## Configure

Copy `tiershift.yaml` into your project and edit. Every threshold is a probability or score from Jev.

```yaml
providers:
  ollama:    { type: openai-compatible, base_url: http://localhost:11434/v1 }
  deepseek:  { type: openai-compatible, base_url: https://api.deepseek.com, api_key_env: DEEPSEEK_API_KEY }
  openai:    { type: openai-compatible, base_url: https://api.openai.com/v1, api_key_env: OPENAI_API_KEY }
  anthropic: { type: anthropic, api_key_env: ANTHROPIC_API_KEY }

tiers:                                  # preference order within a tier
  local:    [ollama/qwen2.5:7b]
  fast:     [deepseek/deepseek-flash, openai/gpt-5.6-luna, anthropic/claude-haiku-4-5]
  mid:      [openai/gpt-5.6-terra, deepseek/deepseek-v4-pro, anthropic/claude-sonnet-5]
  flagship: [anthropic/claude-fable-5-1, openai/gpt-5.6-sol, anthropic/claude-opus-5]

models:                                 # per-model request fields; prices and limits come from prices.yaml
  deepseek/deepseek-flash: { params: { thinking: { type: disabled } } }
  openai/gpt-5.6-luna:     { params: { reasoning_effort: none } }

rules:                                  # first match sets the base tier
  - { when: trivial_ack > 0.8,  tier: local }
  - { when: difficulty < 0.5,   tier: fast }
  - { when: difficulty < 1.3,   tier: mid }
  - { default: flagship }

overrides:                              # all apply, in order
  - { when: stakes > 1.5,                at_least: flagship }
  - { when: safety_sensitive > 0.7,      at_least: flagship }
  - { when: needs_reasoning > 0.8,       at_least: mid }
  - { when: has_tools and tier == local, at_least: fast }
  - { when: difficulty_confidence < 0.5, up: 1 }
  - { when: retries >= 1,                up: 1 }

budget:
  max_cost_per_call: 0.10               # USD; skip models above this estimate
  prefer: order                         # order | cheapest
```

Signals you can use in conditions: `difficulty`, `stakes`, `output_length` (0 to 2), `needs_reasoning`, `has_code`, `ambiguous`, `creative`, `safety_sensitive`, `trivial_ack` (0 to 1), `domain` (string), `difficulty_confidence`, `stakes_confidence`, plus code signals `has_tools`, `tool_count`, `est_input_tokens`, `retries`, `step`, `turn_count`, and the current `tier`.

## Keep prices and limits current

```bash
tiershift sync-models            # dry run: show what would change
tiershift sync-models --write    # update prices.yaml
```

Prices, context windows, max output, and capabilities come from [models.dev](https://models.dev/api.json), a free, open-source, key-less index of about 7,800 models across 220 providers. The bundled GitHub Action runs the sync every Monday and opens a pull request when anything changed. Local models get price zero. Unknown models still route and log cost as null.

Note on DeepSeek: it publishes peak rates and half-price off-peak rates. models.dev carries the off-peak rate. Override in `tiershift.yaml` under `models:` if you want the peak rate for a conservative estimate.

## Provider quirks handled for you

All verified against live APIs on 2026-09-17.

| Provider | Quirk | What tiershift does |
|---|---|---|
| OpenAI gpt-5.x | rejects `max_tokens` | sends `max_completion_tokens` |
| OpenAI gpt-5.6 | rejects function tools unless `reasoning_effort: none` | default config sets it per model |
| DeepSeek flash | thinks by default and spends the token budget on reasoning | default config disables thinking on the fast tier |
| Ollama | 60 times slower with `max_completion_tokens` | sends `max_tokens` |

## CLI

```bash
tiershift check                        # which configured models have keys
tiershift route "your prompt"          # decide only; print signals and reasons
tiershift ask "your prompt"            # decide, call the model, fall back on failure
tiershift sync-models [--write]        # refresh prices.yaml from models.dev
```

Add `--json` for the full object and `--config path` for a custom policy.

## Status

v0.1.0. Library and CLI work end to end across four tiers. 23 unit tests, no network needed. CI runs on Node 20 and 22.

Probe on 12 prompts: easy prompts scored 0.00 to 0.09 on difficulty, hard prompts 1.19 to 2.00. Median Jev latency 278 ms.

Roadmap: OpenAI-compatible proxy with `model: "auto"`, Vercel AI SDK middleware, a post-answer quality gate that retries one tier up, and a published benchmark with quality versus cost across three arms. See [docs/PLAN.md](docs/PLAN.md).

## License

MIT
