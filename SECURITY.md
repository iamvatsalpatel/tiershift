# Security

tiershift sends the last user message, a trimmed system prompt, tool names, and the step type to the TypeSafe API for routing. It sends the full conversation only to the provider it selects. It stores nothing.

API keys are read from environment variables and never logged. Decision logs contain signals and reasons, not message text.

To report a vulnerability, email the maintainer listed in `package.json` or open a private security advisory on GitHub. Please do not open a public issue for security reports.
