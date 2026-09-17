/** Load and validate tiershift.yaml plus bundled prices.yaml. */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Config, ModelMeta } from "./types.js";

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

export function validate(cfg: Config): void {
  if (!cfg.providers || Object.keys(cfg.providers).length === 0) throw new Error("config: `providers` is empty");
  if (!cfg.tiers || Object.keys(cfg.tiers).length === 0) throw new Error("config: `tiers` is empty");
  if (!Array.isArray(cfg.rules) || cfg.rules.length === 0) throw new Error("config: `rules` is empty");
  for (const [tier, models] of Object.entries(cfg.tiers)) {
    if (!Array.isArray(models) || models.length === 0) throw new Error(`config: tier "${tier}" has no models`);
    for (const m of models) {
      const [prov] = m.split("/");
      if (!cfg.providers[prov]) throw new Error(`config: model "${m}" uses unknown provider "${prov}"`);
    }
  }
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
