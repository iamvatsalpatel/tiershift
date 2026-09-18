"""tiershift CLI: route, ask, check, report, tune, explain."""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any

from .analytics import build_report, tune
from .config import available_tiers, load_config
from .log import DEFAULT_LOG, read_log
from .router import create_router


def _load_dotenv() -> None:
    p = Path(".env")
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        if k and k not in os.environ:
            os.environ[k] = v.strip().strip('"').strip("'")


def _usd(x: float) -> str:
    return f"${x:.2f}" if x >= 1 else f"${x:.4f}"


def _pct(x: float) -> str:
    return f"{x * 100:.0f}%"


def _dump(obj: Any) -> str:
    def default(o: Any) -> Any:
        if is_dataclass(o) and not isinstance(o, type):
            d = asdict(o)
            d.pop("raw", None)
            return d
        raise TypeError(type(o).__name__)
    return json.dumps(obj, indent=2, default=default, ensure_ascii=False)


def cmd_check(args: argparse.Namespace) -> int:
    router = create_router(config=args.config, log=False)
    av = router.available()
    for tier, models in router.config["tiers"].items():
        print(f"{tier:<10} " + "   ".join((f"✓ {m}" if m in av[tier] else f"✗ {m} (no key)") for m in models))
    return 0


def cmd_route(args: argparse.Namespace) -> int:
    router = create_router(config=args.config, log=args.log)
    d = router.route([{"role": "user", "content": args.prompt}])
    if args.json:
        print(_dump(d))
        return 0
    s = d.signals
    print(f"→ {d.model}   tier={d.tier}{f' (requested {d.requested_tier}, DEGRADED)' if d.degraded else ''}   fallback={d.fallback or 'none'}")
    print(f"  difficulty {s.difficulty:.2f} (conf {s.difficulty_confidence:.2f})  stakes {s.stakes:.2f}  reasoning {s.needs_reasoning:.2f}  domain {s.domain}  len {s.output_length:.1f}  trivial {s.trivial_ack:.2f}")
    print("  " + "  |  ".join(d.reason))
    est = "unknown" if d.est_cost_usd is None else f"${d.est_cost_usd:.5f}"
    saving = ""
    if d.est_cost_usd is not None and d.est_flagship_cost_usd:
        saving = f" · {d.est_flagship_model} would cost ${d.est_flagship_cost_usd:.5f} → saves {_pct(1 - d.est_cost_usd / d.est_flagship_cost_usd)}"
    print(f"  est cost {est}{saving}")
    print(f"  jev {d.jev_latency_ms} ms, {d.jev_input_tokens} tokens (${d.jev_input_tokens * 0.042 / 1e6:.6f}){f'   logged → {router.log_path}' if router.log_path else ''}")
    return 0


def cmd_ask(args: argparse.Namespace) -> int:
    router = create_router(config=args.config, log=args.log)
    r = router.complete([{"role": "user", "content": args.prompt}], max_tokens=512)
    if args.json:
        print(_dump(r))
        return 0
    d = r.decision
    print(f"→ {r.model}{f'  (fell back from {d.model})' if r.fell_back else ''}   tier={d.tier}{f' (requested {d.requested_tier}, DEGRADED)' if d.degraded else ''}")
    print("  " + "  |  ".join(d.reason))
    total = r.total_cost_usd if r.total_cost_usd is not None else r.cost_usd
    cost = "unknown" if total is None else f"${total:.6f}"
    flag_meta = (router.config.get("models") or {}).get(d.est_flagship_model or "")
    flag_actual = None
    if flag_meta and "price" in flag_meta:
        flag_actual = (r.usage["input_tokens"] * flag_meta["price"]["input"] + r.usage["output_tokens"] * flag_meta["price"]["output"]) / 1e6
    saving = ""
    if total is not None and flag_actual and r.model != d.est_flagship_model:
        saving = f" · {d.est_flagship_model} would cost ${flag_actual:.6f} → saves {_pct(1 - total / flag_actual)}"
    gate = f" · gate P(addresses) {r.gate.addresses:.2f}" if r.gate else ""
    print(f"  jev {d.jev_latency_ms} ms · model {r.latency_ms} ms · {r.usage['input_tokens']} in / {r.usage['output_tokens']} out · cost {cost}{saving}{gate}")
    for a in r.attempts:
        if not a.ok:
            print(f"  ✗ {a.model}: {a.error}")
    print("\n" + r.text.strip())
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    path = args.log or (cfg.get("log") or {}).get("path") or DEFAULT_LOG
    entries = read_log(path)
    if not entries:
        print(f'no decisions in {path}. Route something first: tiershift route "hello"')
        return 0
    tiers = available_tiers(cfg)
    r = build_report(entries, cfg, tiers=tiers)
    if args.json:
        print(_dump(r))
        return 0
    print(f"{r.n} decisions in {path}\n{r.from_ts} → {r.to_ts}\n")
    print(f"{'tier':<10}{'share':>7}{'n':>6}{'cost':>11}{'confidence':>12}{'jev p50':>9}")
    for t in r.tiers:
        print(f"{t.tier:<10}{_pct(t.share):>7}{t.n:>6}{_usd(t.cost):>11}{t.mean_confidence:>12.2f}{f'{t.p50_jev_ms:.0f} ms':>9}")
    print(f"\n{'model':<34}{'n':>6}{'cost':>11}")
    for m in r.models:
        print(f"{m['model']:<34}{m['n']:>6}{_usd(m['cost']):>11}")
    actual = sum(1 for e in entries if e.get("kind") == "complete")
    est_note = f" ({r.n - actual} of {r.n} are estimates; no model was called)" if actual < r.n else ""
    print(f"\ntotal {_usd(r.total_cost)}{est_note}")
    if r.flagship_model and r.saving_vs_flagship is not None:
        top = list(cfg["tiers"].keys())[-1]
        configured_top = cfg["tiers"][top][0]
        note = f"\n  (baseline is your first flagship model with a key; {configured_top} has none)" if r.flagship_model != configured_top else ""
        print(f"always {r.flagship_model} would cost about {_usd(r.flagship_est_cost)} for the same requests → tiershift saved {_pct(r.saving_vs_flagship)}{note}")
    print(f"jev: p50 {r.jev['p50_ms']:.0f} ms, p95 {r.jev['p95_ms']:.0f} ms, {_usd(r.jev['cost'])} total")
    flags = [f for f in (f"{r.low_confidence} low-confidence (<0.5)" if r.low_confidence else "", f"{r.degraded} degraded" if r.degraded else "", f"{r.fell_back} fell back" if r.fell_back else "") if f]
    if flags:
        print("flags: " + ", ".join(flags))
    checks = [t for t in r.tiers if t.estimate_check]
    if checks:
        print("\nestimate vs actual (entries where a model was called):")
        for t in checks:
            c = t.estimate_check or {}
            ratio = c["ratio"]
            how = f"{(ratio - 1) * 100:.0f}% high" if ratio >= 1 else f"{(1 - ratio) * 100:.0f}% low"
            print(f"  {t.tier:<10} n={int(c['n']):<5} estimated {_usd(c['est'])}  actual {_usd(c['actual'])}  (estimate is {how})")
    if r.overrides:
        print("\noverrides fired:")
        for o in r.overrides:
            print(f"  {o['n']:>5}  {o['reason']}")
    return 0


def cmd_tune(args: argparse.Namespace) -> int:
    base = load_config(args.config)
    cand = load_config(args.candidate)
    path = args.log or (base.get("log") or {}).get("path") or DEFAULT_LOG
    entries = read_log(path)
    if not entries:
        print(f"no decisions in {path}")
        return 0
    t = tune(entries, base, cand, tiers=available_tiers(cand))
    if args.json:
        print(_dump(t))
        return 0
    print(f"replayed {t.n} logged decisions against {args.candidate}. No Jev calls, no model calls.\n")
    print(f"{'tier':<10}{'current':>9}{'candidate':>11}")
    for tier in cand["tiers"]:
        print(f"{tier:<10}{t.baseline['tiers'].get(tier, 0):>9}{t.candidate['tiers'].get(tier, 0):>11}")
    held = f"\n{t.held_by_override} would have moved on the rules alone, but an override held them (see `overrides:` in your policy)" if t.held_by_override else ""
    print(f"\nmoved down {t.moved_down}, moved up {t.moved_up}, unchanged {t.unchanged}{held}")
    sv = f" ({'saves' if t.saving >= 0 else 'adds'} {_pct(abs(t.saving))})" if t.saving is not None else ""
    print(f"estimated cost {_usd(t.baseline['est_cost'])} → {_usd(t.candidate['est_cost'])}{sv}")
    if t.moves:
        print("\nmoves to spot-check (difficulty / stakes / confidence):")
        for m in t.moves[:12]:
            print(f"  {m['from']:<9}→ {m['to']:<9} {m['difficulty']:.2f} / {m['stakes']:.2f} / {m['confidence']:.2f}")
        if len(t.moves) > 12:
            print(f"  … {len(t.moves) - 12} more; use --json for all")
    print("\nQuality is not measured here. Sample the moved requests before you adopt the candidate.")
    return 0


def _bar(v: float, mx: float = 1.0) -> str:
    k = round((max(0.0, min(mx, v)) / mx) * 20)
    return "█" * k + "░" * (20 - k)


def cmd_explain(args: argparse.Namespace) -> int:
    """Show the signals and reasons behind the last decision(s). Reads the log; needs no key."""
    cfg = load_config(args.config)
    path = args.log or (cfg.get("log") or {}).get("path") or DEFAULT_LOG
    n = max(1, int(args.last or 1))
    entries = read_log(path)[-n:]
    if not entries:
        print(f'no decisions in {path}. Route something first: tiershift route "hello"')
        return 0
    if args.json:
        print(json.dumps(entries, indent=2, ensure_ascii=False))
        return 0
    for e in entries:
        s = e["signals"]
        cs = e.get("code_signals") or {}
        tag = f"  tag={e['tag']}" if e.get("tag") else ""
        print(f"\n{e['ts']}  {e['kind']}{tag}")
        req = f" (requested {e['requested_tier']})" if e.get("requested_tier") != e.get("tier") else ""
        print(f"→ {e['model']}   tier={e['tier']}{req}{'  fell back' if e.get('fell_back') else ''}{'  DEGRADED' if e.get('degraded') else ''}")
        print(f"  difficulty      {_bar(s['difficulty'], 2)} {s['difficulty']:.2f} / 2   confidence {s['difficulty_confidence']:.2f}")
        print(f"  stakes          {_bar(s['stakes'], 2)} {s['stakes']:.2f} / 2   confidence {s['stakes_confidence']:.2f}")
        print(f"  output_length   {_bar(s['output_length'], 2)} {s['output_length']:.2f} / 2")
        for k in ("needs_reasoning", "mid_tier_ok", "has_code", "ambiguous", "creative", "safety_sensitive", "trivial_ack"):
            print(f"  {k:<16}{_bar(s[k])} {s[k]:.2f}")
        tools = f"   tools {cs.get('tool_count')}" if cs.get("has_tools") else ""
        retries = f"   retries {cs.get('retries')}" if cs.get("retries") else ""
        print(f"  domain          {s['domain']} ({s['domain_confidence']:.2f})   tokens in ~{cs.get('est_input_tokens')}{tools}{retries}")
        print("  why             " + "\n                  ".join(e.get("reason") or []))
        cost = e.get("cost_usd") if e.get("cost_usd") is not None else e.get("est_cost_usd")
        est_note = " (estimate)" if e.get("cost_usd") is None else ""
        gate = f"   gate P(addresses) {e['gate_addresses']:.2f}" if e.get("gate_addresses") is not None else ""
        print(f"  cost            {'unknown' if cost is None else f'${cost:.5f}{est_note}'}   jev {e['jev_latency_ms']} ms{gate}")
    return 0


def _common(sp: argparse.ArgumentParser) -> None:
    """--config and --json are accepted before or after the subcommand. SUPPRESS keeps a subparser from clobbering the parent value."""
    sp.add_argument("--config", default=argparse.SUPPRESS, help="path to tiershift.yaml (default: ./tiershift.yaml, then bundled)")
    sp.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="machine-readable output")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="tiershift", description="Shift every LLM call to the cheapest model that can handle it.")
    _common(p)
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("route", help="decide a model for one prompt; calls Jev only")
    r.add_argument("prompt")
    r.add_argument("--log", help="decision log path")
    _common(r)
    r.set_defaults(fn=cmd_route)
    a = sub.add_parser("ask", help="decide, call the model, fall back on failure")
    a.add_argument("prompt")
    a.add_argument("--log", help="decision log path")
    _common(a)
    a.set_defaults(fn=cmd_ask)
    c = sub.add_parser("check", help="show which configured models have keys")
    _common(c)
    c.set_defaults(fn=cmd_check)
    rp = sub.add_parser("report", help="tier mix, spend, and saving vs always-flagship from the decision log")
    rp.add_argument("--log", help="decision log path")
    _common(rp)
    rp.set_defaults(fn=cmd_report)
    t = sub.add_parser("tune", help="replay logged decisions against another policy; no API calls")
    t.add_argument("--candidate", required=True, help="path to the candidate tiershift.yaml")
    t.add_argument("--log", help="decision log path")
    _common(t)
    t.set_defaults(fn=cmd_tune)
    ex = sub.add_parser("explain", help="show the signals and reasons behind the last decision(s)")
    ex.add_argument("--last", type=int, default=1, help="how many recent decisions to show")
    ex.add_argument("--log", help="decision log path")
    _common(ex)
    ex.set_defaults(fn=cmd_explain)
    return p


def main(argv: list[str] | None = None) -> int:
    _load_dotenv()
    args = build_parser().parse_args(argv)
    args.config = getattr(args, "config", None)
    args.json = getattr(args, "json", False)
    try:
        return int(args.fn(args))
    except Exception as e:  # keep tracebacks out of the terminal; --json users get the message on stderr
        print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
