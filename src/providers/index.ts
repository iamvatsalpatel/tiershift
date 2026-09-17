/** Build Provider instances from the `providers:` section of the config. */
import type { Config } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { Provider } from "./types.js";

export * from "./types.js";
export { OpenAICompatibleProvider } from "./openai-compatible.js";
export { AnthropicProvider } from "./anthropic.js";

export function buildProviders(config: Config, env: Record<string, string | undefined> = process.env): Record<string, Provider> {
  const out: Record<string, Provider> = {};
  for (const [name, p] of Object.entries(config.providers)) {
    const apiKey = p.api_key_env ? env[p.api_key_env] : undefined;
    if (p.api_key_env && !apiKey) continue; // no key, provider is unavailable; router already skips its models
    if (p.type === "anthropic") out[name] = new AnthropicProvider({ name, apiKey, baseURL: p.base_url });
    else out[name] = new OpenAICompatibleProvider({ name, baseURL: p.base_url ?? "https://api.openai.com/v1", apiKey });
  }
  return out;
}
