# Decision log, report, and tune

Every decision is logged to `.tiershift/decisions.jsonl` by default: signals, tier, model, cost, latency, and the reasons. Never message text. Two commands read it.

```
$ tiershift report
120 decisions in .tiershift/decisions.jsonl

tier        share     n       cost  confidence  jev p50
local         18%    22    $0.0000        0.97   202 ms
fast          33%    39    $0.0017        0.83   146 ms
mid           28%    34    $0.2036        0.56   129 ms
flagship      21%    25    $0.8057        0.61   132 ms

total $1.01 (all 120 are estimates; no model was called)
always openai/gpt-5.6-sol would cost about $1.22 for the same requests → tiershift saved 17%
jev: p50 140 ms, p95 350 ms, $0.0049 total
flags: 24 low-confidence (<0.5)
```

That is real output. The 120 prompts were routed with `route()` only, so Jev cost half a cent and no provider was called. When you use `complete()`, the log carries actual token usage and the report shows actual spend.

```
$ tiershift tune --candidate examples/policies/bolder.yaml
replayed 120 logged decisions against examples/policies/bolder.yaml. No Jev calls, no model calls.

tier        current  candidate
local            22         22
fast             39         40
mid              34         38
flagship         25         20

moved down 6, moved up 0, unchanged 114
3 would have moved on the rules alone, but an override held them
estimated cost $1.01 → $0.9672 (saves 4%)

moves to spot-check (difficulty / stakes / confidence):
  flagship → mid       1.34 / 0.60 / 0.39
  flagship → mid       1.55 / 0.91 / 0.32
  ...
```

`tune` replays the logged signals against another YAML. It costs nothing, because the signals are already in the log. It tells you which requests would move, in which direction, and what the estimated cost change is. It does not measure quality. Sample the moved requests before you adopt a candidate.

Disable logging with `log: { enabled: false }` in the YAML, or `createRouter({ log: false })`. Add a `tag` to each call to split the report by agent or tenant later.

## Keep prices and limits current

```bash
tiershift sync-models            # dry run: show what would change
tiershift sync-models --write    # update prices.yaml
```

Prices, context windows, max output, and capabilities come from [models.dev](https://models.dev/api.json), a free, open-source, key-less index of about 7,800 models across 220 providers. The bundled GitHub Action runs the sync every Monday and opens a pull request when anything changed. Local models get price zero. Unknown models still route and log cost as null.

Note on DeepSeek: it publishes peak rates and half-price off-peak rates. models.dev carries the off-peak rate. Override in `tiershift.yaml` under `models:` if you want the peak rate for a conservative estimate.
