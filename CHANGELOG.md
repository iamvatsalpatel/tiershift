# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-17

### Added
- `createRouter()` with `route()` for decisions and `complete()` for decide, call, and fall back one tier up.
- Ten Jev signals in one request: difficulty, needs_reasoning, stakes, domain, has_code, ambiguous, output_length, creative, safety_sensitive, trivial_ack.
- YAML policy with ordered rules, `at_least` and `up` overrides, budget cap, and `prefer: cheapest`.
- Provider adapters: one OpenAI-compatible adapter for OpenAI, DeepSeek, Groq, Together, OpenRouter, Gemini, and Ollama, plus an Anthropic adapter on the official SDK.
- `tiershift sync-models` pulls prices, context windows, and capabilities from models.dev into `prices.yaml`. A weekly GitHub Action opens a pull request with changes.
- CLI: `route`, `ask`, `check`, `sync-models`.
- Degrade-down: when no model at or above the chosen tier has a key, use the best available model below and flag the decision.
