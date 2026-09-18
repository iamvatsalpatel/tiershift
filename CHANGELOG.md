# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-09-17

First release.

### Added
- `createRouter()` with `route()` for decisions and `complete()` for decide, call, and fall back one tier up.
- Ten Jev signals in one request: difficulty, needs_reasoning, stakes, domain, has_code, ambiguous, output_length, creative, safety_sensitive, trivial_ack.
- YAML policy with ordered rules, `at_least` and `up` overrides, budget cap, and `prefer: cheapest`.
- Provider adapters: one OpenAI-compatible adapter for OpenAI, DeepSeek, Groq, Together, OpenRouter, Gemini, and Ollama, plus an Anthropic adapter on the official SDK.
- `tiershift sync-models` pulls prices, context windows, and capabilities from models.dev into `prices.yaml`. A weekly GitHub Action opens a pull request with changes.
- CLI: `route`, `ask`, `check`, `sync-models`.
- Degrade-down: when no model at or above the chosen tier has a key, use the best available model below and flag the decision.
- Decision log at `.tiershift/decisions.jsonl` (on by default, no message text) with `tiershift report` for tier mix, spend, and saving against always-flagship, and `tiershift tune --candidate` to replay logged signals against another policy with no API calls. Per-call `tag` for splitting by agent or tenant.
- Benchmark in `bench/`: 120 prompts in four categories, three arms (always flagship, always fast, tiershift), a blind LLM judge, per-category and traffic-mix analysis, a quality-versus-cost chart, and cached reruns. Results published in `bench/results.md`.
- `tiershift serve`: OpenAI-compatible chat-completions proxy on `node:http`. `model: "auto"` routes per request, explicit ids bypass routing, decisions are returned in `x-tiershift-*` headers, `stream: true` pipes provider SSE through for OpenAI-compatible providers, `GET /v1/models` lists `auto` plus configured models. Binds to 127.0.0.1 by default.
- `Provider.streamRaw()` optional method, implemented by the OpenAI-compatible adapter.
- Proxy decision-log parity with `router.complete()`: routed non-streaming requests write a `complete` entry with actual tokens, cost, and model latency; streaming requests write a route-only entry; explicit ids write nothing. Per-model YAML `params` take precedence over client-sent fields.
- `mid_tier_ok` signal: Jev's direct judgment of whether a mid-tier model would answer well. Not used by the default rules; a commented `at_most` example shows how.
- `at_most` override action, the mirror of `at_least`: lowers the tier to a ceiling.
- Load-time policy validation. Unknown signals, tiers, or providers, unparsable conditions, a non-positive `up`, a `default` that is not last, and an override with no action all fail at `loadConfig()` with the location quoted and a did-you-mean hint.
- `defaults.min_output_tokens` (default 1024): a floor on `max_tokens` for models with the `reasoning` capability.
- Empty-answer retry: an empty answer with finish reason `length` counts as a failure, so `complete()` moves to the fallback.
- `tiershift report` shows estimated versus actual cost per tier when both kinds of entries exist.
- Router, security, and validation test suites. Test count 57 → 92.
- Python package `tiershift` on PyPI (`python/`): `create_router`, `route`, `complete`, CLI with `route`, `ask`, `check`, `report`, `tune`. Shares the YAML, prices, decision-log format, and conformance fixtures with the npm package, including `mid_tier_ok`, `at_most`, load-time validation, the pinned Jev model, `min_output_tokens`, empty-answer retry, key redaction, and the per-tier estimate check.

### Design decisions
- The Jev client is created on first `route()`. `check`, `report`, `tune`, `sync-models`, and `--help` work without `TYPESAFE_API_KEY`; routing without it fails with a clear message.
- The Jev model is pinned to `jev-1.13.0` by default instead of `jev-latest`. Routing depends on the model, so upgrades are deliberate.
- Provider error text is redacted of every configured API key before it reaches an attempt record or a thrown error.
