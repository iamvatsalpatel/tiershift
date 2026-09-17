# Benchmark results

Run date 2026-09-17. 120 prompts, 3 arms, max_tokens 4096. Judge: `openai/gpt-5.6-sol` (blind, sees prompt and answer only).

Arms: `always_flagship` = openai/gpt-5.6-sol, `always_fast` = deepseek/deepseek-flash, `tiershift` = routed by the default policy. tiershift cost includes the Jev routing call.

## Headline

| Arm | Mean quality (1-5) | Share scored 4 or 5 | Total cost | Cost per 1,000 prompts | p50 latency | p95 latency | Judged | Empty answers |
|---|---|---|---|---|---|---|---|---|
| always_flagship | 4.83 | 96% | $1.5872 | $13.2270 | 1865 ms | 67055 ms | 120/120 | 4 |
| always_fast | 4.49 | 86% | $0.0447 | $0.3723 | 1361 ms | 12381 ms | 120/120 | 0 |
| tiershift | 4.78 | 96% | $1.4802 | $12.3350 | 2031 ms | 70428 ms | 120/120 | 4 |

**Read:** tiershift reached 99.1% of flagship quality at 93.3% of flagship cost. always_fast reached 93.1% of flagship quality at 2.8% of the cost.

## Quality by category

| Category | always_flagship | always_fast | tiershift |
|---|---|---|---|
| ack | 5.00 | 4.80 | 4.80 |
| simple | 5.00 | 5.00 | 5.00 |
| moderate | 4.97 | 4.57 | 4.97 |
| hard | 4.33 | 3.60 | 4.37 |

## Cost by category (total, USD)

| Category | always_flagship | always_fast | tiershift |
|---|---|---|---|
| ack | $0.0094 | $0.0007 | $0.0017 |
| simple | $0.0138 | $0.0012 | $0.0023 |
| moderate | $0.1408 | $0.0101 | $0.1058 |
| hard | $1.4233 | $0.0327 | $1.3703 |

## Where tiershift sent each category

Rows are the author's expected tier. Columns are the tier tiershift chose. Diagonal is agreement. Off-diagonal is not automatically wrong; see quality above.

| expected \ chosen | local | fast | mid | flagship | n |
|---|---|---|---|---|---|
| ack (local) | 23 | 6 | 1 | 0 | 30 |
| simple (fast) | 0 | 30 | 0 | 0 | 30 |
| moderate (mid) | 0 | 1 | 26 | 3 | 30 |
| hard (flagship) | 0 | 0 | 6 | 24 | 30 |

Agreement with author labels: 103/120 (86%). Fell back to the next tier on 0 prompts.

## Models used by the tiershift arm

| Model | Prompts | Mean quality | Total cost |
|---|---|---|---|
| deepseek/deepseek-flash | 37 | 5.00 | $0.0028 |
| ollama/qwen2.5:7b | 23 | 4.74 | $0.0009 |
| openai/gpt-5.6-sol | 27 | 4.37 | $1.3160 |
| openai/gpt-5.6-terra | 33 | 4.91 | $0.1605 |

## Routing overhead

Jev call: p50 199 ms, p95 504 ms, total $0.0049 for 120 routes ($0.0405 per 1,000).

## Lowest-scoring routed answers

| id | tier | model | score | judge note | difficulty | stakes |
|---|---|---|---|---|---|---|
| hard-13 | flagship | openai/gpt-5.6-sol | 1 | No answer provided; the requested design, API, technology choice, and conflict examples are all missing. | 1.98 | 1.28 |
| hard-21 | flagship | openai/gpt-5.6-sol | 1 | No answer provided; the requested schema, query plan, and technology comparison are entirely missing. | 2.00 | 1.65 |
| hard-27 | flagship | openai/gpt-5.6-sol | 1 | No answer provided; the incident response plan and forensic considerations are entirely missing. | 1.43 | 2.00 |
| hard-29 | flagship | openai/gpt-5.6-sol | 1 | No answer was provided, so the permission system and N+1 avoidance were not addressed. | 1.92 | 1.83 |
| ack-23 | local | ollama/qwen2.5:7b | 3 | Polite but ignores the user's clear intent to end the conversation and unnecessarily asks for more requests. | 0.00 | 0.00 |
| ack-03 | local | ollama/qwen2.5:7b | 4 | Reasonable clarification without prior context, though slightly generic and verbose. | 0.06 | 0.10 |
| ack-04 | local | ollama/qwen2.5:7b | 4 | Appropriate conversational response, though slightly verbose for a simple acknowledgment. | 0.02 | 0.03 |
| ack-08 | local | ollama/qwen2.5:7b | 4 | Correctly acknowledges receipt, though the added caveat and question are unnecessary. | 0.00 | 0.02 |

## What the saving depends on: your traffic mix

Hard prompts cost about 100 times more than acknowledgements on every arm, so they dominate spend. Routing saves money in proportion to the share of easy traffic. Per-prompt mean cost from this run:

| Category | always_flagship | always_fast | tiershift | tiershift vs flagship |
|---|---|---|---|---|
| ack | $0.00031 | $0.00002 | $0.00006 | 82% cheaper |
| simple | $0.00046 | $0.00004 | $0.00008 | 83% cheaper |
| moderate | $0.00469 | $0.00034 | $0.00353 | 25% cheaper |
| hard | $0.04744 | $0.00109 | $0.04568 | 4% cheaper |

Applied to four traffic mixes. The three named mixes are illustrative shares, not measured traffic. Quality is the mix-weighted mean of per-category quality from this run.

| Mix (ack / simple / moderate / hard) | Arm | Quality | Cost per 1,000 | Saving vs flagship |
|---|---|---|---|---|
| This benchmark (25 / 25 / 25 / 25) | always_flagship | 4.83 | $13.23 | baseline |
|  | always_fast | 4.49 | $0.37 | 97% |
|  | tiershift | 4.78 | $12.33 | 7% |
| Coding agent (illustrative) (40 / 20 / 30 / 10) | always_flagship | 4.92 | $6.37 | baseline |
|  | always_fast | 4.65 | $0.23 | 96% |
|  | tiershift | 4.85 | $5.66 | 11% |
| Support assistant (illustrative) (30 / 50 / 20 / 0) | always_flagship | 4.99 | $1.26 | baseline |
|  | always_fast | 4.85 | $0.09 | 93% |
|  | tiershift | 4.93 | $0.76 | 40% |
| Research assistant (illustrative) (10 / 20 / 40 / 30) | always_flagship | 4.79 | $16.23 | baseline |
|  | always_fast | 4.39 | $0.47 | 97% |
|  | tiershift | 4.78 | $15.14 | 7% |

## Chart

![Quality against cost, three arms](chart-light.svg)

Rebuild with `npm run bench:chart`. A dark variant is in `chart-dark.svg`.

## Caveats

- One judge model, from the same family as the flagship arm. It may favor that family's style. Judge cost is excluded from every arm.
- Expected tiers are author labels, used only for the agreement matrix.
- max_tokens 4096 caps long answers equally across arms.
- Prices from `prices.yaml` via models.dev on 2026-09-17. DeepSeek is listed at the off-peak rate.
- Every raw record is in `results.jsonl`. Rerun `npm run bench:report` to rebuild this file.
