# Conformance fixtures

Both packages, TypeScript and Python, must produce identical decisions from identical inputs. These fixtures are the contract.

- `policy.yaml` — a policy that exercises every rule and override form.
- `cases.json` — signals plus code signals in, expected tier and reason lines out.
- `log-entry.json` — one decision log line. Both packages must read and write this shape.

Run the TypeScript side with `npm test`. Run the Python side with `uv run pytest`. Add a case here first when you change policy semantics, then make both packages pass.
