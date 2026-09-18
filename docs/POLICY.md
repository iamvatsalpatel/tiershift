# Policy reference

Every threshold in `tiershift.yaml` is a probability or score from Jev. Change a number, change the routing. No retraining.

Copy `tiershift.yaml` into your project and edit.

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

rules:                                  # first match sets the base tier; default must be last
  - { default: fast }

overrides:                              # all apply, in order
  - { when: needs_reasoning > 0.8 or difficulty >= 1.3, at_least: mid }
  - { when: stakes > 1.5 or safety_sensitive > 0.7,     at_least: mid }
  - { when: has_tools and tier == local,                 at_least: fast }
  - { when: retries >= 1,                                up: 1 }
  # opt in: the hardest high-stakes work to the flagship
  # - { when: stakes > 1.5 and difficulty >= 1.3, at_least: flagship }
  # opt in: pure acknowledgements to a free local model
  # - { when: trivial_ack > 0.8 and stakes < 0.5, at_most: local }

gate:                                   # opt in: judge fast-tier answers, retry one tier up below the threshold
  enabled: false
  threshold: 0.5
  tiers: [fast]
```

## Rule and override semantics

- `rules` run in order. The first `when` that matches sets the base tier. `default` must be last.
- `overrides` all run, in order, after the rules. `at_least` raises the tier to a floor. `at_most` lowers it to a ceiling. `up: N` moves N tiers up. They never move past the top or bottom tier.
- Conditions: `signal OP value`, with `>` `<` `>=` `<=` `==` `!=`. Join with `and` and `or`; `and` binds tighter. A bare boolean name such as `has_tools` is a condition on its own. Strings may be bare or quoted.
- A typo fails at load time with the location and a did-you-mean hint.

## Model selection inside a tier

The first model in the tier whose provider key is present wins, unless `budget.prefer: cheapest`. A model is skipped when the request would exceed its context window, when the request has tools and the model lacks the `tools` capability, or when its estimated cost exceeds `budget.max_cost_per_call`. If no model in the chosen tier fits, tiershift walks up one tier at a time. If nothing at or above the chosen tier has a key, it degrades to the best model below and marks the decision `degraded: true` (set `degrade: false` to throw instead).

## Reasoning models

Models with the `reasoning` capability spend output tokens thinking before they answer. `defaults.min_output_tokens` (default 1024) floors `max_tokens` for them. An empty answer with finish reason `length` counts as a failure, and `complete()` moves to the fallback.

## Pin the Jev model

`jev.model` defaults to `jev-1.13.0`. Routing depends on the model, so a new Jev version changes decisions. Upgrade on purpose: set the new version, replay your log with `tiershift tune`, then ship.

## Answer gate

With `gate.enabled: true`, `complete()` sends each answer from a listed tier to Jev with one question: does the answer fully and correctly address the request? Below `threshold`, the answer is discarded, its cost is still billed, and the request retries on the fallback one tier up. The gate never runs on tool calls or on the last candidate. It adds 650 to 1000 ms per gated answer and about $0.00002. On the benchmark it raised quality by 0.03 for one point of saving. `CompleteResult.gate` carries the probability, and the log entry carries `gate_addresses`.
