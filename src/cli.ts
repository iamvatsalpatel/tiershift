#!/usr/bin/env node
/** tiershift CLI. `tiershift route "prompt"` prints the decision. `tiershift check` prints available models. */
import * as fsMod from "node:fs";
import { createRouter } from "./router.js";
import { syncModels } from "./sync-models.js";
import { readLog, DEFAULT_LOG } from "./log.js";
import { buildReport, tune } from "./analytics.js";
import { loadConfig, availableTiers } from "./config.js";

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

  if (cmd === "sync-models") {
    const write = args.includes("--write");
    const r = await syncModels({ configPath: cfgPath, write });
    if (json) { console.log(JSON.stringify(r, null, 2)); return; }
    for (const c of r.changes) console.log(`  ${c.model.padEnd(34)} ${c.field.padEnd(12)} ${JSON.stringify(c.from) ?? "unset"} → ${JSON.stringify(c.to)}`);
    if (r.changes.length === 0) console.log("  prices.yaml already matches models.dev");
    for (const m of r.missing) console.log(`  ! ${m} not found on models.dev; kept as is`);
    for (const m of r.local) console.log(`  · ${m} is local; price set to 0`);
    console.log(write ? `wrote ${r.path}` : `dry run. add --write to update ${r.path}`);
    return;
  }

  const usd = (x: number) => (x >= 1 ? `$${x.toFixed(2)}` : `$${x.toFixed(4)}`);
  const pctf = (x: number) => `${(x * 100).toFixed(0)}%`;
  const logIdx = args.indexOf("--log");
  const logPathArg = logIdx >= 0 ? args.splice(logIdx, 2)[1] : undefined;

  if (cmd === "report") {
    const cfg = loadConfig(cfgPath);
    const path = logPathArg ?? cfg.log?.path ?? DEFAULT_LOG;
    const entries = readLog(path);
    if (entries.length === 0) { console.log(`no decisions in ${path}. Route something first: tiershift route "hello"`); return; }
    const tiers = availableTiers(cfg, process.env);
    const r = buildReport(entries, cfg, { tiers });
    if (json) { console.log(JSON.stringify(r, null, 2)); return; }
    console.log(`${r.n} decisions in ${path}\n${r.from} → ${r.to}\n`);
    console.log(`${"tier".padEnd(10)}${"share".padStart(7)}${"n".padStart(6)}${"cost".padStart(11)}${"confidence".padStart(12)}${"jev p50".padStart(9)}`);
    for (const t of r.tiers) console.log(`${t.tier.padEnd(10)}${pctf(t.share).padStart(7)}${String(t.n).padStart(6)}${usd(t.cost).padStart(11)}${t.mean_confidence.toFixed(2).padStart(12)}${(t.p50_jev_ms + " ms").padStart(9)}`);
    const checks = r.tiers.filter((t) => t.estimate_check);
    if (checks.length) { console.log(`\nestimate vs actual (entries where a model was called):`); for (const t of checks) { const c = t.estimate_check!; console.log(`  ${t.tier.padEnd(10)} n=${String(c.n).padEnd(5)} estimated ${usd(c.est)}  actual ${usd(c.actual)}  (estimate is ${c.ratio >= 1 ? `${((c.ratio - 1) * 100).toFixed(0)}% high` : `${((1 - c.ratio) * 100).toFixed(0)}% low`})`); } }
    console.log(`\n${"model".padEnd(34)}${"n".padStart(6)}${"cost".padStart(11)}`);
    for (const m of r.models) console.log(`${m.model.padEnd(34)}${String(m.n).padStart(6)}${usd(m.cost).padStart(11)}`);
    const actual = entries.filter((e) => e.kind === "complete").length;
    console.log(`\ntotal ${usd(r.total_cost)}${actual < r.n ? ` (${r.n - actual} of ${r.n} are estimates; no model was called)` : ""}`);
    if (r.flagship_model && r.saving_vs_flagship !== null) {
      const top = Object.keys(cfg.tiers).at(-1)!;
      const configuredTop = cfg.tiers[top][0];
      console.log(`always ${r.flagship_model} would cost about ${usd(r.flagship_est_cost)} for the same requests → tiershift saved ${pctf(r.saving_vs_flagship)}${r.flagship_model !== configuredTop ? `\n  (baseline is your first flagship model with a key; ${configuredTop} has none)` : ""}`);
    }
    console.log(`jev: p50 ${r.jev.p50_ms} ms, p95 ${r.jev.p95_ms} ms, ${usd(r.jev.cost)} total`);
    const flags = [r.low_confidence ? `${r.low_confidence} low-confidence (<0.5)` : "", r.degraded ? `${r.degraded} degraded` : "", r.fell_back ? `${r.fell_back} fell back` : ""].filter(Boolean);
    if (flags.length) console.log(`flags: ${flags.join(", ")}`);
    if (r.overrides.length) { console.log(`\noverrides fired:`); for (const o of r.overrides) console.log(`  ${String(o.n).padStart(5)}  ${o.reason}`); }
    return;
  }

  if (cmd === "tune") {
    const candIdx = args.indexOf("--candidate");
    const candPath = candIdx >= 0 ? args.splice(candIdx, 2)[1] : undefined;
    if (!candPath) { console.error("usage: tiershift tune --candidate other.yaml [--config tiershift.yaml] [--log path] [--json]"); process.exit(2); }
    const base = loadConfig(cfgPath), cand = loadConfig(candPath);
    const path = logPathArg ?? base.log?.path ?? DEFAULT_LOG;
    const entries = readLog(path);
    if (entries.length === 0) { console.log(`no decisions in ${path}`); return; }
    const t = tune(entries, base, cand, { tiers: availableTiers(cand, process.env) });
    if (json) { console.log(JSON.stringify(t, null, 2)); return; }
    console.log(`replayed ${t.n} logged decisions against ${candPath}. No Jev calls, no model calls.\n`);
    const tiers = Object.keys(cand.tiers);
    console.log(`${"tier".padEnd(10)}${"current".padStart(9)}${"candidate".padStart(11)}`);
    for (const tier of tiers) console.log(`${tier.padEnd(10)}${String(t.baseline.tiers[tier] ?? 0).padStart(9)}${String(t.candidate.tiers[tier] ?? 0).padStart(11)}`);
    console.log(`\nmoved down ${t.moved_down}, moved up ${t.moved_up}, unchanged ${t.unchanged}${t.held_by_override ? `\n${t.held_by_override} would have moved on the rules alone, but an override held them (see \`overrides:\` in your policy)` : ""}`);
    console.log(`estimated cost ${usd(t.baseline.est_cost)} → ${usd(t.candidate.est_cost)}${t.saving !== null ? ` (${t.saving >= 0 ? "saves" : "adds"} ${pctf(Math.abs(t.saving))})` : ""}`);
    if (t.moves.length) {
      console.log(`\nmoves to spot-check (difficulty / stakes / confidence):`);
      for (const m of t.moves.slice(0, 12)) console.log(`  ${m.from.padEnd(9)}→ ${m.to.padEnd(9)} ${m.difficulty.toFixed(2)} / ${m.stakes.toFixed(2)} / ${m.confidence.toFixed(2)}`);
      if (t.moves.length > 12) console.log(`  … ${t.moves.length - 12} more; use --json for all`);
    }
    console.log(`\nQuality is not measured here. Sample the moved requests before you adopt the candidate.`);
    return;
  }

  const router = createRouter({ config: cfgPath, log: logPathArg });

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
    console.log(`  jev ${d.jev_latency_ms} ms, ${d.jev_input_tokens} tokens ($${(d.jev_input_tokens * 0.042 / 1e6).toFixed(6)})   est call cost ${d.est_cost_usd === null ? "unknown" : "$" + d.est_cost_usd.toFixed(5)}${router.logPath ? `   logged → ${router.logPath}` : ""}`);
    return;
  }

  if (cmd === "ask") {
    const prompt = args.join(" ").trim();
    if (!prompt) { console.error('usage: tiershift ask "your prompt" [--json] [--config path]'); process.exit(2); }
    const r = await router.complete({ messages: [{ role: "user", content: prompt }], maxTokens: 512 });
    if (json) { const { raw, ...rest } = r; console.log(JSON.stringify(rest, null, 2)); return; }
    const d = r.decision;
    console.log(`→ ${r.model}${r.fell_back ? `  (fell back from ${d.model})` : ""}   tier=${d.tier}${d.degraded ? ` (requested ${d.requested_tier}, DEGRADED)` : ""}`);
    console.log(`  ${d.reason.join("  |  ")}`);
    console.log(`  jev ${d.jev_latency_ms} ms · model ${r.latency_ms} ms · ${r.usage.input_tokens} in / ${r.usage.output_tokens} out · cost ${r.cost_usd === null ? "unknown" : "$" + r.cost_usd.toFixed(6)}`);
    if (r.attempts.some((a) => !a.ok)) for (const a of r.attempts.filter((a) => !a.ok)) console.log(`  ✗ ${a.model}: ${a.error}`);
    console.log(`\n${r.text.trim()}`);
    return;
  }

  console.log(`tiershift — shift every LLM call to the cheapest model that can handle it.

  tiershift route "prompt" [--json] [--config tiershift.yaml]   decide a model for one prompt
  tiershift ask "prompt" [--json] [--config tiershift.yaml]     decide, call the model, fall back on failure
  tiershift check [--config tiershift.yaml]                      show which configured models have keys
  tiershift sync-models [--write]                                pull prices and limits from models.dev into prices.yaml
  tiershift report [--log path] [--json]                         tier mix, spend, and saving vs always-flagship from the decision log
  tiershift tune --candidate other.yaml [--log path]             replay logged decisions against another policy; no API calls`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
