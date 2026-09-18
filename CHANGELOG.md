# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing yet.

## [0.2.0] - 2026-09-18

The default policy changed. Routing decisions differ from 0.1.0 for the same prompts: the flagship tier is now opt-in. Replay your log with `tiershift tune --candidate` before upgrading a production policy, or pin your own `rules:`.

### Added
- Answer gate (opt in, `gate:` in the YAML): after a fast-tier answer, one Jev call checks that the answer addresses the request; below the threshold, `complete()` retries one tier up. `CompleteResult.gate` and `total_cost_usd` report it; the log entry carries `gate_addresses`.
- `Decision.est_flagship_cost_usd` and `est_flagship_model`: what the same request would cost on the top tier. `route` and `ask` print the saving per decision.
- `tiershift explain [--last N]`: the eleven signals, the reasons, and the cost behind recent decisions.

### Changed
- Default policy is escalate-only: every request starts on the fast tier; `needs_reasoning > 0.8 or difficulty >= 1.3` and `stakes > 1.5 or safety_sensitive > 0.7` lift to mid. The flagship and local tiers are off by default; one commented line each turns them on. On the benchmark this matched always-flagship quality at 60 percent of its cost; the first default saved 7 percent.
- Benchmark: four arms (always flagship, always mid, always fast, tiershift), one shared answer per model and prompt, two blind judges from families that wrote no answers (Sonnet 5 and DeepSeek v4-pro), judge agreement reported. Models are pinned by env vars so a new provider key never changes the arms.
- README rewritten around the measured result. Reference material moved to `docs/`.

### Fixed
- `package.json`: `bin` path and `repository.url` in the form npm expects, so `npm publish` no longer warns.
- PyPI metadata: license file and classifier so the project page shows MIT.

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
