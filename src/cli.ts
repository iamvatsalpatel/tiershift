#!/usr/bin/env node
/** tiershift CLI. `tiershift route "prompt"` prints the decision. `tiershift check` prints available models. */
import * as fsMod from "node:fs";
import { createRouter } from "./router.js";

function loadDotenv() {
  try {
    const fs = fsMod;
    for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env is fine */ }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const cfgIdx = rest.indexOf("--config");
  const cfgPath = cfgIdx >= 0 ? rest.splice(cfgIdx, 2)[1] : undefined;
  const json = rest.includes("--json");
  const args = rest.filter((a) => a !== "--json");

  loadDotenv();
  const router = createRouter({ config: cfgPath });

  if (cmd === "check") {
    const av = router.available();
    for (const [tier, models] of Object.entries(router.config.tiers)) {
      console.log(`${tier.padEnd(10)} ${models.map((m) => (av[tier].includes(m) ? `✓ ${m}` : `✗ ${m} (no key)`)).join("   ")}`);
    }
    return;
  }

  if (cmd === "route") {
    const prompt = args.join(" ").trim();
    if (!prompt) { console.error('usage: tiershift route "your prompt" [--json] [--config path]'); process.exit(2); }
    const d = await router.route({ messages: [{ role: "user", content: prompt }] });
    if (json) { console.log(JSON.stringify(d, null, 2)); return; }
    const s = d.signals;
    console.log(`→ ${d.model}   tier=${d.tier}${d.degraded ? ` (requested ${d.requested_tier}, DEGRADED)` : ""}   fallback=${d.fallback ?? "none"}`);
    console.log(`  difficulty ${s.difficulty.toFixed(2)} (conf ${s.difficulty_confidence.toFixed(2)})  stakes ${s.stakes.toFixed(2)}  reasoning ${s.needs_reasoning.toFixed(2)}  domain ${s.domain}  len ${s.output_length.toFixed(1)}  trivial ${s.trivial_ack.toFixed(2)}`);
    console.log(`  ${d.reason.join("  |  ")}`);
    console.log(`  jev ${d.jev_latency_ms} ms, ${d.jev_input_tokens} tokens ($${(d.jev_input_tokens * 0.042 / 1e6).toFixed(6)})   est call cost ${d.est_cost_usd === null ? "unknown" : "$" + d.est_cost_usd.toFixed(5)}`);
    return;
  }

  console.log(`tiershift — shift every LLM call to the cheapest model that can handle it.

  tiershift route "prompt" [--json] [--config tiershift.yaml]   decide a model for one prompt
  tiershift check [--config tiershift.yaml]                      show which configured models have keys`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
