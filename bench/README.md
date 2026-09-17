# tiershift benchmark

Question the benchmark answers: **does routing save money without losing quality, compared to always calling one model?**

## Design

- **Dataset**: 120 prompts in `prompts.jsonl`. Each has `id`, `category`, `expected_tier`, and `prompt`. Four categories that mirror an agent run:
  - `ack` — acknowledgements, confirmations, formatting (30). Expected tier: local.
  - `simple` — lookups, short rewrites, small facts (30). Expected tier: fast.
  - `moderate` — code snippets, explanations, small debugging (30). Expected tier: mid.
  - `hard` — design, proofs, legal or financial analysis, multi-step planning (30). Expected tier: flagship.
  Expected tiers are the author's labels. They measure *routing agreement*, not truth. A route that disagrees with the label is not automatically wrong.

- **Arms**: every prompt runs through three arms with the same `max_tokens`.
  1. `always_flagship` — the top model of the flagship tier.
  2. `always_fast` — the top model of the fast tier.
  3. `tiershift` — routed by the default `tiershift.yaml`.

- **Quality**: an LLM judge scores each answer 1 to 5 against the prompt. The judge is the flagship model. It sees the prompt and the answer, never the model name. Judging is blind. Judge cost is reported separately and is not part of any arm's cost.

- **Cost**: actual reported usage times `prices.yaml`. Routing cost for the tiershift arm includes the Jev call.

- **Latency**: end to end per prompt, including the Jev call for the routed arm.

## Output

`results.md` with one table per arm (mean quality, total cost, p50 and p95 latency), a per-category breakdown, the tier histogram for the routed arm, and the routing agreement matrix. `results.jsonl` has every raw record so anyone can recompute.

## Honesty rules

- Publish the numbers we get. If routing loses, say so.
- The judge is one model. Report its cost and note the bias risk: it may prefer its own family's style.
- Cached runs replay from `cache/` so the report is reproducible without spending again. Delete `cache/` to rerun live.

## Run

```bash
npm run bench            # live, about $1 to $3 depending on the flagship model
npm run bench:report     # rebuild results.md from results.jsonl
```
