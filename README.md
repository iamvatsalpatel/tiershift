# tiershift

**Shift every LLM call to the cheapest model that can handle it.**
Routing decided by [TypeSafe Jev](https://docs.typesafe.ai) in about 280 ms for $0.00003 per call. No training data. Policy in plain YAML.

```
$ tiershift route "Review this indemnification clause for risk: Vendor shall indemnify Client against all claims arising from any cause whatsoever"
→ ollama/qwen2.5:7b   tier=local (requested flagship, DEGRADED)   fallback=none
  difficulty 0.99 (conf 0.94)  stakes 1.99  reasoning 0.68  domain legal_finance  len 1.0  trivial 0.02
  rule "difficulty < 1.3" → mid  |  override "stakes > 1.5" → at_least flagship  |  DEGRADED: no usable model in flagship or above, using local

$ tiershift route "ok thanks"
→ ollama/qwen2.5:7b   tier=local   fallback=none
  difficulty 0.00 (conf 1.00)  stakes 0.00  reasoning 0.03  domain general  len 0.0  trivial 0.97
  rule "trivial_ack > 0.8" → local
  jev 337 ms, 946 tokens ($0.000040)   est call cost $0.00000
```

Both runs above are real output from a laptop with only Ollama running and no cloud keys. The policy asked for `flagship` on the legal clause because stakes scored 1.99. No flagship key was present, so tiershift degraded to the local model and said so. Add an Anthropic or DeepSeek key and the same prompt routes to the flagship tier.

## Why

An agent run has ten steps. Seven are trivial: acknowledge a tool result, reformat, pick a branch. Most agents send all ten to the flagship model. tiershift sends each step to the cheapest tier that can handle it, and moves up when the stakes are high, the confidence is low, or a retry happened.

Existing routers learn a black box from labeled data and need retraining when you add a model. tiershift asks Jev ten narrow questions about the prompt, then applies rules you can read. Adding a model is one YAML line.

| | RouteLLM | NotDiamond | tiershift |
|---|---|---|---|
| Training data | preference pairs | 15 to 10,000 labels | none |
| Add a model | retrain | retrain | one YAML line |
| Policy | learned | learned | plain YAML, inspectable |
| Signals per route | 1 | 1 | 10 from Jev plus token count, tools, step, retries |
| Every decision logged with probabilities | no | no | yes |
| Route latency | ~10 ms local | ~100 to 200 ms | ~280 ms |

Honest note: a local classifier is faster. Next to a 5-second flagship call, 280 ms is small. Next to a 1-second small-model call, it is 20 percent overhead. The pitch is zero training, transparent policy, and multi-signal escalation.

## How it works

```
prompt ─► code signals ─► Jev: 10 questions in one call ─► YAML rules and overrides ─► model + fallback
          tokens, tools,     difficulty, stakes, reasoning,    thresholds on probabilities;
          step, retries      domain, length, safety, ...       context, capability, and budget checks in code
```

Jev judges meaning. Code does arithmetic. Jev never sees prices or token counts, because [Jev is not a calculator](https://docs.typesafe.ai/model-jaggedness/jev-1.13). Code checks context fit, estimates cost from `prices.yaml`, and skips models over budget.

## Install

```bash
npm install tiershift
export TYPESAFE_API_KEY=...        # get one at typesafe.ai
```

Provider keys are optional. A tier skips any model whose key is missing. With only [Ollama](https://ollama.com) running, everything routes to the local model and the decision is flagged `DEGRADED`.

## Use

```ts
import { createRouter } from "tiershift";

const router = createRouter();                  // reads ./tiershift.yaml or the bundled default

const d = await router.route({
  messages,                                     // your conversation so far
  tools,                                        // optional tool definitions
  step: "plan",                                 // optional agent step type
  retries: 0,                                   // optional; each retry moves one tier up
});

d.model        // "anthropic/claude-haiku-4-5-20251001"
d.tier         // "fast"
d.fallback     // "anthropic/claude-sonnet-5"   use this if the call fails
d.signals      // { difficulty: 0.63, stakes: 0.73, needs_reasoning: 0.51, ... }
d.reason       // ['rule "difficulty < 1.3" → mid', 'override "stakes > 1.5" → at_least flagship']
d.est_cost_usd // 0.0021
```

Then call the model with your own client. tiershift decides. It does not proxy. A proxy mode is planned, see the roadmap.

## Configure

Copy `tiershift.yaml` into your project and edit. Every threshold is a probability or score from Jev.

```yaml
providers:
  ollama:    { type: openai-compatible, base_url: http://localhost:11434/v1 }
  deepseek:  { type: openai-compatible, base_url: https://api.deepseek.com, api_key_env: DEEPSEEK_API_KEY }
  anthropic: { type: anthropic, api_key_env: ANTHROPIC_API_KEY }

tiers:                                  # preference order within a tier
  local:    [ollama/qwen2.5:7b]
  fast:     [deepseek/deepseek-chat, anthropic/claude-haiku-4-5-20251001]
  mid:      [anthropic/claude-sonnet-5]
  flagship: [anthropic/claude-fable-5-1]

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

## CLI

```bash
tiershift check                        # which configured models have keys
tiershift route "your prompt"          # decide, print signals and reasons
tiershift route "your prompt" --json   # full decision object
```

## Status

v0.1: library and CLI. Routing is live and tested on a 12-prompt probe: easy prompts scored 0.00 to 0.09 on difficulty, hard prompts 1.19 to 2.00, median Jev latency 278 ms.

Roadmap: OpenAI-compatible proxy with `model: "auto"`, Vercel AI SDK middleware, a post-answer quality gate that retries one tier up, and a published benchmark with quality-versus-cost across three arms. See [docs/PLAN.md](docs/PLAN.md).

## License

MIT
