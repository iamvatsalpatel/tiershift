# CLI

```bash
tiershift serve [--port 4141]          # OpenAI-compatible proxy; clients set model "auto"
tiershift check                        # which configured models have keys
tiershift route "your prompt"          # decide only; print signals and reasons; no model call
tiershift ask "your prompt"            # decide, call the model, fall back on failure
tiershift report [--log path]          # tier mix, spend, saving vs always-flagship from the log
tiershift tune --candidate other.yaml  # replay the log against another policy; no API calls
tiershift sync-models [--write]        # refresh prices.yaml from models.dev
tiershift explain [--last N]           # signals, reasons, and cost behind the last N decisions
```

Add `--json` for the full object and `--config path` for a custom policy.
