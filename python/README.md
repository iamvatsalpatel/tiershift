# tiershift (Python)

**Shift every LLM call to the cheapest model that can handle it.**
Routing decided by [TypeSafe Jev](https://docs.typesafe.ai) in about 300 ms for $0.00004 per call. No training data. Policy in plain YAML.

This is the Python package. It shares one `tiershift.yaml` format, one `prices.yaml`, and one decision-log format with the [npm package](https://github.com/iamvatsalpatel/tiershift), so `report` and `tune` read logs written by either.

## Install

```bash
uv add tiershift          # or: pip install tiershift
export TYPESAFE_API_KEY=...   # get one at typesafe.ai
```

Provider keys are optional. A tier skips any model whose key is missing. With only [Ollama](https://ollama.com) running, everything routes to the local model and the decision is flagged `degraded=True`.

## Use

```python
from tiershift import create_router

router = create_router()                        # reads ./tiershift.yaml, else the bundled default

d = router.route(messages, tools=tools, step="plan", retries=0)
d.model          # "deepseek/deepseek-flash"
d.tier           # "fast"
d.fallback       # "openai/gpt-5.6-terra"       use this if the call fails
d.signals        # Signals(difficulty=0.31, stakes=0.12, needs_reasoning=0.08, ...)
d.reason         # ['rule "difficulty < 0.5" → fast']
d.est_cost_usd   # 0.00006

r = router.complete(messages, tools=tools, max_tokens=1024)   # decide, call, fall back one tier up on failure
r.text, r.model, r.fell_back, r.cost_usd, r.attempts
```

`route()` calls Jev only. It never calls a provider. `complete()` tries the chosen model, then the fallback one tier up. 4xx validation errors do not trigger a fallback.

Messages are plain dicts with `role` and `content`, the same shape the OpenAI and Anthropic SDKs use. Tools are dicts with `name`, `description`, and `parameters`.

## CLI

```bash
tiershift check                        # which configured models have keys
tiershift route "your prompt"          # decide only; Jev call, no model call
tiershift ask "your prompt"            # decide, call the model, fall back on failure
tiershift report                       # tier mix, spend, saving vs always-flagship from the log
tiershift tune --candidate other.yaml  # replay the log against another policy; no API calls
```

Add `--json` for the full object and `--config path` for a custom policy.

## Configure

Copy `tiershift.yaml` from the [repository](https://github.com/iamvatsalpatel/tiershift/blob/main/tiershift.yaml) into your project and edit. Every threshold is a probability or score from Jev. The format, the available signals, and the provider quirks are documented in the main README.

## Status

Sync API only. Async `route`/`complete` are planned. The test suite needs no network and includes every shared conformance case from `conformance/`.

## License

MIT
