# The proxy

```bash
tiershift serve                       # http://127.0.0.1:4141/v1
```

Point any OpenAI-compatible client at it and set `model` to `auto`. No other code changes. Python:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:4141/v1", api_key="unused")

r = client.chat.completions.with_raw_response.create(
    model="auto",
    messages=[{"role": "user", "content": "Review this clause for legal risk: ..."}],
)
print(r.headers["x-tiershift-model"], r.headers["x-tiershift-tier"])   # openai/gpt-5.6-sol flagship
print(r.headers["x-tiershift-reason"])   # rule "difficulty < 1.3" -> mid | override "stakes > 1.5" -> at_least flagship
print(r.parse().choices[0].message.content)
```

- `model: "auto"` routes. `model: "auto:billing"` routes and writes `billing` as the tag in the decision log.
- An explicit id such as `model: "deepseek/deepseek-flash"` bypasses routing and costs no Jev call.
- Per-model `params` in your YAML take precedence over the same fields sent by the client.
- Routed non-streaming requests write a `complete` entry with actual token usage to the decision log, so `tiershift report` shows real spend for proxy traffic. Streaming requests log the routing decision with an estimated cost, because usage is not available when piping SSE through.
- `GET /v1/models` lists `auto` plus every configured model with its tier and whether a key is present.
- Every response carries the decision in headers: `x-tiershift-model`, `x-tiershift-tier`, `x-tiershift-fallback`, `x-tiershift-confidence`, `x-tiershift-jev-ms`, `x-tiershift-reason`, plus `x-tiershift-fell-back: true` when the fallback answered. Headers never contain message text or keys.
- `stream: true` pipes the provider's server-sent events through unchanged. Streaming works for OpenAI-compatible providers. A request that routes to an Anthropic model with `stream: true` gets a clear 400; send `stream: false` for that tier in v0.1.
- Fallback to the next tier applies when the chosen provider fails before answering. A provider 4xx passes through with its status.

The proxy has no authentication. It binds to `127.0.0.1` by default. Bind elsewhere with `--host` only behind your own auth.
