# Benchmark results

Run date 2026-09-18. 120 prompts, 4 arms, max_tokens 4096. Primary judge `anthropic/claude-sonnet-5`, second judge `deepseek/deepseek-v4-pro`. Both blind: they see the prompt and the answer, never the model.

Arms: `always_flagship` = openai/gpt-5.6-sol, `always_mid` = openai/gpt-5.6-terra, `always_fast` = deepseek/deepseek-flash, `tiershift` = the shipped default policy choosing among exactly those models plus ollama/qwen2.5:7b. One answer per (model, prompt) is shared across arms, so tiershift is judged on the same answer the fixed arm got. tiershift cost includes the Jev routing call and any failed attempt before a fallback.

## Headline

| Arm | Mean quality (1-5) | Share scored 4 or 5 | Total cost | Cost per 1,000 prompts | p50 latency | p95 latency | Judged | Empty answers |
|---|---|---|---|---|---|---|---|---|
| always_flagship | 4.77 | 94% | $1.5872 | $13.2270 | 1865 ms | 67055 ms | 120/120 | 4 |
| always_mid | 4.85 | 98% | $1.0491 | $8.7428 | 1699 ms | 55139 ms | 120/120 | 0 |
| always_fast | 4.78 | 93% | $0.0447 | $0.3723 | 1361 ms | 12381 ms | 120/120 | 0 |
| tiershift | 4.77 | 94% | $0.9546 | $7.9547 | 1832 ms | 55310 ms | 120/120 | 0 |

**Read:** tiershift: 100.0% of flagship quality at 60% of flagship cost. always_mid: 101.7% of flagship quality at 66% of flagship cost. always_fast: 100.3% of flagship quality at 3% of flagship cost.

## Quality by category

| Category | always_flagship | always_mid | always_fast | tiershift |
|---|---|---|---|---|
| ack | 4.73 | 4.83 | 4.53 | 4.53 |
| simple | 4.97 | 4.97 | 4.90 | 4.90 |
| moderate | 4.90 | 4.83 | 4.93 | 4.93 |
| hard | 4.47 | 4.77 | 4.77 | 4.70 |

## Cost by category (total, USD)

| Category | always_flagship | always_mid | always_fast | tiershift |
|---|---|---|---|---|
| ack | $0.0094 | $0.0038 | $0.0007 | $0.0019 |
| simple | $0.0138 | $0.0099 | $0.0012 | $0.0024 |
| moderate | $0.1408 | $0.1111 | $0.0101 | $0.0454 |
| hard | $1.4233 | $0.9244 | $0.0327 | $0.9048 |

## Where tiershift sent each category

Rows are the author's expected tier. Columns are the tier tiershift chose. Diagonal is agreement. Off-diagonal is not automatically wrong; see quality above.

| expected \ chosen | fast | mid | n |
|---|---|---|---|
| ack (local) | 30 | 0 | 30 |
| simple (fast) | 30 | 0 | 30 |
| moderate (mid) | 26 | 4 | 30 |
| hard (flagship) | 2 | 28 | 30 |

Agreement with author labels: 34/120 (28%). Fell back to the next tier on 0 prompts.

## Models used by the tiershift arm

| Model | Prompts | Mean quality | Total cost |
|---|---|---|---|
| deepseek/deepseek-flash | 88 | 4.76 | $0.0151 |
| openai/gpt-5.6-terra | 32 | 4.78 | $0.9395 |

## Routing overhead

Jev call: p50 180 ms, p95 454 ms, total $0.0050 for 120 routes ($0.0418 per 1,000).

## Lowest-scoring routed answers

| id | tier | model | score | judge note | difficulty | stakes |
|---|---|---|---|---|---|---|
| ack-13 | fast | deepseek/deepseek-flash | 2 | Fabricates prior context (no earlier chapter exists in conversation); prompt is ambiguous, should have asked for clarification instead of inventing a story. | 0.26 | 0.05 |
| ack-05 | fast | deepseek/deepseek-flash | 3 | No prior context exists, so claiming to have cancelled something is a fabricated action; should have asked for clarification. | 0.00 | 0.07 |
| ack-06 | fast | deepseek/deepseek-flash | 3 | Fine reply, but emoji is a mismatched stylistic choice for a CLI coding tool's tone. | 0.00 | 0.00 |
| ack-09 | fast | deepseek/deepseek-flash | 3 | No actual plan was given in context, but answer confirms understanding regardless; harmless but slightly presumptuous. | 0.06 | 0.05 |
| ack-22 | fast | deepseek/deepseek-flash | 3 | No prior context given; reply is reasonable but reader can't verify appropriateness without conversation history. | 0.01 | 0.01 |
| ack-23 | fast | deepseek/deepseek-flash | 3 | User wrote in English but reply is in Chinese, mismatched language despite being otherwise fine. | 0.00 | 0.00 |
| simple-17 | fast | deepseek/deepseek-flash | 3 | Correct answer but heavily overformatted with unnecessary steps for a trivial comparison question. | 0.00 | 0.00 |
| ack-01 | fast | deepseek/deepseek-flash | 4 | Appropriate brief reply; emoji slightly unnecessary but not an error, fits trivial prompt. | 0.00 | 0.00 |

## What the saving depends on: your traffic mix

Hard prompts cost about 100 times more than acknowledgements on every arm, so they dominate spend. Routing saves money in proportion to the share of easy traffic. Per-prompt mean cost from this run:

| Category | always_flagship | always_fast | tiershift | tiershift vs flagship |
|---|---|---|---|---|
| ack | $0.00031 | $0.00002 | $0.00006 | 79% cheaper |
| simple | $0.00046 | $0.00004 | $0.00008 | 83% cheaper |
| moderate | $0.00469 | $0.00034 | $0.00151 | 68% cheaper |
| hard | $0.04744 | $0.00109 | $0.03016 | 36% cheaper |

Applied to four traffic mixes. The three named mixes are illustrative shares, not measured traffic. Quality is the mix-weighted mean of per-category quality from this run.

| Mix (ack / simple / moderate / hard) | Arm | Quality | Cost per 1,000 | Saving vs flagship |
|---|---|---|---|---|
| This benchmark (25 / 25 / 25 / 25) | always_flagship | 4.77 | $13.23 | baseline |
|  | always_mid | 4.85 | $8.74 | 34% |
|  | always_fast | 4.78 | $0.37 | 97% |
|  | tiershift | 4.77 | $7.95 | 40% |
| Coding agent (illustrative) (40 / 20 / 30 / 10) | always_flagship | 4.80 | $6.37 | baseline |
|  | always_mid | 4.85 | $4.31 | 32% |
|  | always_fast | 4.75 | $0.23 | 96% |
|  | tiershift | 4.74 | $3.51 | 45% |
| Support assistant (illustrative) (30 / 50 / 20 / 0) | always_flagship | 4.88 | $1.26 | baseline |
|  | always_mid | 4.90 | $0.94 | 25% |
|  | always_fast | 4.80 | $0.09 | 93% |
|  | tiershift | 4.80 | $0.36 | 71% |
| Research assistant (illustrative) (10 / 20 / 40 / 30) | always_flagship | 4.77 | $16.23 | baseline |
|  | always_mid | 4.84 | $10.80 | 33% |
|  | always_fast | 4.84 | $0.47 | 97% |
|  | tiershift | 4.82 | $9.68 | 40% |

## Judge agreement

480 answers scored by both judges. Exact agreement 85%, within one point 94%.

| Arm | Mean, anthropic/claude-sonnet-5 | Mean, deepseek/deepseek-v4-pro |
|---|---|---|
| always_flagship | 4.77 | 4.78 |
| always_mid | 4.85 | 4.88 |
| always_fast | 4.78 | 4.85 |
| tiershift | 4.77 | 4.88 |

## Chart

![Quality against cost, three arms](chart-light.svg)

Rebuild with `npm run bench:chart`. A dark variant is in `chart-dark.svg`.

## Caveats

- The primary judge wrote none of the answers. The second judge shares a family with the fast arm. Judge cost is excluded from every arm.
- Expected tiers are author labels, used only for the agreement matrix.
- max_tokens 4096 caps long answers equally across arms.
- Prices from `prices.yaml` via models.dev on 2026-09-18. DeepSeek is listed at the off-peak rate.
- Every raw record is in `results.jsonl`. Rerun `npm run bench:report` to rebuild this file.
