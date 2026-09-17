/** Load and validate tiershift.yaml plus bundled prices.yaml. */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { parseCondition, suggest } from "./policy.js";
import type { Config, ModelMeta, Override, Rule } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Works from both src/ (tsx) and dist/ (built). */
export const PKG_ROOT = existsSync(join(here, "..", "tiershift.yaml")) ? join(here, "..") : join(here, "..", "..");

export function loadPrices(): Record<string, ModelMeta> {
  const p = join(PKG_ROOT, "prices.yaml");
  return existsSync(p) ? (parse(readFileSync(p, "utf8")) as Record<string, ModelMeta>) : {};
}

export function loadConfig(path?: string): Config {
  const file = path ? resolve(path) : existsSync(resolve("tiershift.yaml")) ? resolve("tiershift.yaml") : join(PKG_ROOT, "tiershift.yaml");
  const cfg = parse(readFileSync(file, "utf8")) as Config;
  validate(cfg);
  cfg.models = mergeModelMeta(loadPrices(), cfg.models ?? {});
  return cfg;
}

/** Per-model shallow merge. A config entry that only sets `params` keeps the bundled price and context. */
export function mergeModelMeta(bundled: Record<string, ModelMeta>, overrides: Record<string, ModelMeta>): Record<string, ModelMeta> {
  const out: Record<string, ModelMeta> = { ...bundled };
  for (const [id, meta] of Object.entries(overrides)) out[id] = { ...(bundled[id] ?? {}), ...meta };
  return out;
}

/** Throw `config: <where>: <what>` so a typo is found at load time, not on the first matching request. */
function fail(where: string, what: string): never { throw new Error(`config: ${where}: ${what}`); }

function checkCondition(where: string, when: unknown): void {
  if (typeof when !== "string" || when.trim().length === 0) fail(where, `\`when\` must be a non-empty string`);
  try { parseCondition(when); } catch (e) { fail(where, e instanceof Error ? e.message : String(e)); }
}

function checkTierName(where: string, name: unknown, tiers: string[]): void {
  if (typeof name !== "string" || !tiers.includes(name)) fail(where, `unknown tier "${String(name)}"${suggest(String(name), tiers)}. Tiers: ${tiers.join(", ")}`);
}

export function validate(cfg: Config): void {
  if (!cfg || typeof cfg !== "object") throw new Error("config: file is empty or not a YAML mapping");
  if (!cfg.providers || Object.keys(cfg.providers).length === 0) throw new Error("config: `providers` is empty");
  if (!cfg.tiers || Object.keys(cfg.tiers).length === 0) throw new Error("config: `tiers` is empty");
  if (!Array.isArray(cfg.rules) || cfg.rules.length === 0) throw new Error("config: `rules` is empty");
  const tierNames = Object.keys(cfg.tiers);
  for (const [tier, models] of Object.entries(cfg.tiers)) {
    if (!Array.isArray(models) || models.length === 0) throw new Error(`config: tier "${tier}" has no models`);
    for (const m of models) {
      if (typeof m !== "string" || !m.includes("/")) fail(`tiers.${tier}`, `model "${String(m)}" must be "provider/model"`);
      const [prov] = m.split("/");
      if (!cfg.providers[prov]) fail(`tiers.${tier}`, `model "${m}" uses unknown provider "${prov}"${suggest(prov, Object.keys(cfg.providers))}`);
    }
  }
  for (const [name, p] of Object.entries(cfg.providers)) {
    if (!p || (p.type !== "openai-compatible" && p.type !== "anthropic")) fail(`providers.${name}`, `\`type\` must be "openai-compatible" or "anthropic"`);
  }
  cfg.rules.forEach((rule: Rule, i: number) => {
    const where = `rules[${i}]`;
    const hasWhen = rule.when !== undefined, hasTier = rule.tier !== undefined, hasDefault = rule.default !== undefined;
    if (hasDefault) {
      if (hasWhen || hasTier) fail(where, `a \`default\` rule cannot also have \`when\` or \`tier\``);
      checkTierName(`${where}.default`, rule.default, tierNames);
      if (i !== cfg.rules.length - 1) fail(where, `\`default\` must be the last rule; rules after it never run`);
      return;
    }
    if (!hasWhen || !hasTier) fail(where, `a rule needs both \`when\` and \`tier\`, or a single \`default\``);
    checkCondition(`${where}.when`, rule.when);
    checkTierName(`${where}.tier`, rule.tier, tierNames);
  });
  (cfg.overrides ?? []).forEach((ov: Override, i: number) => {
    const where = `overrides[${i}]`;
    checkCondition(`${where}.when`, ov.when);
    const actions = ["at_least", "at_most", "up"].filter((k) => (ov as unknown as Record<string, unknown>)[k] !== undefined);
    if (actions.length === 0) fail(where, `needs one of \`at_least\`, \`at_most\`, or \`up\``);
    if (ov.at_least !== undefined) checkTierName(`${where}.at_least`, ov.at_least, tierNames);
    if (ov.at_most !== undefined) checkTierName(`${where}.at_most`, ov.at_most, tierNames);
    if (ov.up !== undefined && (!Number.isInteger(ov.up) || ov.up <= 0)) fail(`${where}.up`, `must be a positive integer, got ${JSON.stringify(ov.up)}`);
  });
  if (cfg.budget?.prefer !== undefined && cfg.budget.prefer !== "order" && cfg.budget.prefer !== "cheapest") fail("budget.prefer", `must be "order" or "cheapest"`);
  if (cfg.fallback !== undefined && cfg.fallback !== "up" && cfg.fallback !== "none") fail("fallback", `must be "up" or "none"`);
  if (cfg.defaults?.min_output_tokens !== undefined && (!Number.isInteger(cfg.defaults.min_output_tokens) || cfg.defaults.min_output_tokens < 0)) fail("defaults.min_output_tokens", `must be a non-negative integer`);
}

/** Split "provider/model-id" into parts. The model id may contain slashes or colons. */
export function splitModel(id: string): { provider: string; model: string } {
  const i = id.indexOf("/");
  if (i < 0) throw new Error(`Model id "${id}" must be "provider/model"`);
  return { provider: id.slice(0, i), model: id.slice(i + 1) };
}

/** Tiers filtered to models whose provider has a key (or needs none). A tier with no usable model keeps its full list. */
export function availableTiers(cfg: Config, env: Record<string, string | undefined> = process.env): Record<string, string[]> {
  const usable = (id: string) => { const p = cfg.providers[splitModel(id).provider]; return !!p && (!p.api_key_env || Boolean(env[p.api_key_env])); };
  return Object.fromEntries(Object.entries(cfg.tiers).map(([tier, models]) => { const av = models.filter(usable); return [tier, av.length ? av : models]; }));
}
