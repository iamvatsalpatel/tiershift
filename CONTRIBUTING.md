# Contributing

Thanks for helping. Small, focused pull requests are easiest to review.

## Setup

```bash
git clone https://github.com/iamvatsalpatel/tiershift
cd tiershift
npm install
cp .env.example .env      # add TYPESAFE_API_KEY
npm test                  # unit tests, no network
npm run dev -- route "hello"   # live route through Jev
```

## Rules

- Keep Jev questions atomic. One judgment per question. Put the definition in the criteria.
- Keep math in code. Jev never sees prices, token counts, or dates.
- Every new signal needs a unit test in `src/policy.test.ts` and a line in the README signal list.
- Do not commit `.env`, keys, or decision logs.
- Verify prices in `prices.yaml` against the provider page and cite the date in the commit message.

## Reporting a bad route

Open an issue with the `--json` output of `tiershift route "..."`. That includes every signal and reason line, so the fix is usually a threshold change in `tiershift.yaml`.
