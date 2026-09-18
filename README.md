<h1 align="center">tiershift</h1>

<p align="center">
  <b>Stop paying flagship prices for prompts that don't need one.</b><br>
  tiershift reads each request, picks the cheapest model tier that can handle it, and escalates on evidence.<br>
  The judgment comes from <a href="https://docs.typesafe.ai">TypeSafe Jev</a>, a calibrated decision model. About 180 ms. Four cents per thousand routes.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tiershift"><img alt="npm" src="https://img.shields.io/npm/v/tiershift?label=npm&color=2a78d6"></a>
  <a href="https://pypi.org/project/tiershift/"><img alt="PyPI" src="https://img.shields.io/pypi/v/tiershift?label=pypi&color=2a78d6"></a>
  <a href="https://github.com/iamvatsalpatel/tiershift/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/iamvatsalpatel/tiershift/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-2a78d6"></a>
</p>

```
$ tiershift route "thanks, that's all for now"
→ deepseek/deepseek-flash     fast      default → fast

$ tiershift route "Prove there are infinitely many primes of the form 4k+3."
→ openai/gpt-5.6-terra        mid       needs_reasoning 0.97 → at_least mid

$ tiershift route "Redline this clause: Vendor indemnifies Client against all claims whatsoever."
→ openai/gpt-5.6-terra        mid       stakes 1.98 → at_least mid
```

Three real routes. Every request starts on the fast tier. It moves up only when Jev finds a reason: multi-step reasoning, hard difficulty, high stakes, or safety. The reason is printed with every decision, and `tiershift explain` shows every signal behind the last one.

## What we measured

120 prompts, from one-word acknowledgements to system design and legal review. Four ways to pick a model. Every answer scored blind by two judges from model families that wrote none of the answers.

<p align="center"><img src="bench/chart-light.svg" alt="Quality against cost for four routing strategies" width="800"></p>

| Strategy | Quality, 1 to 5 | Cost per 1,000 prompts | Answers that came back empty |
|---|---|---|---|
| Always the flagship, gpt-5.6-sol | 4.77 | $13.23 | 4 |
| **tiershift, default policy** | **4.77** | **$7.95** | **0** |
| Always the mid model, gpt-5.6-terra | 4.85 | $8.74 | 0 |
| Always the fast model, deepseek-flash | 4.78 | $0.37 | 0 |

**The finding that matters is the bottom row.** On these prompts, the fast model matched the flagship at 3 percent of the cost. The flagship gave the single best answer on 3 prompts out of 120. On 4 prompts it returned nothing at all, because its reasoning consumed the entire output budget, and it billed $0.33 for those four empty answers.

**tiershift matched the flagship's quality and cut the cost 40 percent.** It sent 88 prompts to the fast model and lifted 32 to the mid model on evidence: multi-step reasoning, hard difficulty, high stakes, or safety. All 18 prompts Jev scored as high stakes went to the mid model, 0 went to the fast model, and the mid model matched or beat the flagship on every one of those categories. The routing cost a median of 180 ms and $0.04 per 1,000 prompts. The flagship tier stays in the config, off by default, one line to turn on.

**What this benchmark cannot show.** These are single-turn prompts with clear answers. Frontier models earn their price on long agentic tasks with tools, large context, and recovery from mistakes. That is the next benchmark, and until it runs, treat the flagship column above as "on plain prompts". Method, every raw record, and both judges' scores are in [bench/](bench/). Rerun it with `npm run bench`; answers and judgments are cached, so a rerun is free.

## Use it

**TypeScript**

```ts
import { createRouter } from "tiershift";

const router = createRouter();                      // reads ./tiershift.yaml, else the bundled default
const r = await router.complete({ messages });      // decide, call the model, fall back one tier up on failure
r.text; r.model; r.cost_usd; r.decision.reason;     // ['default → fast', 'override "stakes > 1.5" → at_least flagship']
```

**Python**

```python
from tiershift import create_router

router = create_router()
r = router.complete(messages)
r.text, r.model, r.cost_usd, r.decision.reason
```

**Any language, zero code change.** Run the proxy and set `model: "auto"`.

```bash
tiershift serve                                     # http://127.0.0.1:4141/v1
```

```python
client = OpenAI(base_url="http://127.0.0.1:4141/v1", api_key="unused")
client.chat.completions.create(model="auto", messages=messages)
# response headers: x-tiershift-model, x-tiershift-tier, x-tiershift-reason
```

Install: `npm install tiershift` or `pip install tiershift`. Set `TYPESAFE_API_KEY` from [typesafe.ai](https://typesafe.ai). Provider keys are optional; a tier skips any model whose key is missing, and with only [Ollama](https://ollama.com) running everything routes locally.

## How it works

```
request ─► Jev: 11 questions, one call, ~180 ms ─► your YAML policy ─► model, fallback, reason
            difficulty · stakes · needs_reasoning        thresholds on probabilities;
            safety · domain · output_length · ...        context, capability, and budget checks in code
```

Jev is not a language model. It returns typed probabilities and scores, calibrated against outcomes, and never generates text. That is why it answers eleven questions in one 180 ms call. tiershift asks the questions; your YAML turns the answers into a tier; code does every piece of arithmetic. Jev never sees a price or a token count.

The default policy, in full:

```yaml
rules:
  - default: fast
overrides:
  - { when: needs_reasoning > 0.8 or difficulty >= 1.3, at_least: mid }
  - { when: stakes > 1.5 or safety_sensitive > 0.7,     at_least: mid }
  - { when: retries >= 1,                                up: 1 }
  # - { when: stakes > 1.5 and difficulty >= 1.3,        at_least: flagship }   # opt in
```

Change a number, change the routing. No training data, no retraining. Adding a model is one line under `tiers:`.

## Prove it on your own traffic

Every decision is logged: signals, tier, model, cost, latency, reason. Never the message text. Every `route` and `ask` prints what the flagship would have cost for the same request.

```
$ tiershift report
tier        share     n       cost
fast          73%    88    $0.0087
mid           27%    32    $0.5597
total $0.57 (estimates; no model was called)
always anthropic/claude-fable-5-1 would cost about $3.06 for the same requests → tiershift saved 81%

$ tiershift route "Prove there are infinitely many primes of the form 4k+3."
→ openai/gpt-5.6-terra   tier=mid
  est cost $0.00483 · anthropic/claude-fable-5-1 would cost $0.02015 → saves 76%

$ tiershift tune --candidate bolder.yaml     # replay your log against another policy; no API calls
$ tiershift explain                          # the eleven signals and the reasons behind the last decision
```

The 81 percent above is a token-count estimate against Fable 5.1, the most expensive model in the default config, on the same 120 prompts. The 40 percent in the benchmark table is measured against GPT-5.6-sol with judged answers. Your number depends on which flagship you are paying for today and what your traffic looks like. Run your traffic through `route()` for a day, then read `report`.

## Docs

[Policy reference](docs/POLICY.md) · [Providers](docs/PROVIDERS.md) · [Proxy](docs/PROXY.md) · [Decision log, report, tune](docs/DECISION-LOG.md) · [CLI](docs/CLI.md) · [Benchmark](bench/) · [Python package](python/README.md) · [Changelog](CHANGELOG.md)

Related: [jev-router](https://github.com/gargpratyush/jev-router) routes each turn inside the Claude Code and Codex CLIs with Jev, using your existing subscription. tiershift is for the agents you build and the API bills you pay.

## License

MIT
