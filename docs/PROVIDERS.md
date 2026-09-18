# Providers

Two adapters cover almost every provider.

| Adapter | Covers | Config |
|---|---|---|
| `openai-compatible` | OpenAI, DeepSeek, Groq, Together, OpenRouter, Gemini (OpenAI endpoint), Ollama | `base_url`, `api_key_env` |
| `anthropic` | Claude models | `api_key_env` |

## Quirks handled for you

All verified against live APIs on 2026-09-17.

| Provider | Quirk | What tiershift does |
|---|---|---|
| OpenAI gpt-5.x | rejects `max_tokens` | sends `max_completion_tokens` |
| OpenAI gpt-5.6 | rejects function tools unless `reasoning_effort: none` | default config sets it per model |
| DeepSeek flash | thinks by default and spends the token budget on reasoning | default config disables thinking on the fast tier |
| Ollama | 60 times slower with `max_completion_tokens` | sends `max_tokens` |
| Any reasoning model | spends output tokens thinking first; a small budget returns an empty answer at full price | raises `max_tokens` to `defaults.min_output_tokens` (1024), and treats an empty answer with finish reason `length` as a failure so the fallback runs |
