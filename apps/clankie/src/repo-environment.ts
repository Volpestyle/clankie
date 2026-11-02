import { parseEnv } from "node:util";
import { loadBundledCatalog } from "@clankie/model-registry";

const PROVIDER_ENVIRONMENT_NAMES = new Set(
  Object.values(loadBundledCatalog()).flatMap((provider) => provider.env ?? []),
);

/**
 * Apply only the provider API-key fallbacks `.env.local` is documented to hold.
 * Returns the names it applied, which never leave the service's own process.
 */
export function applyRepoProviderEnvironment(contents: string, environment: NodeJS.ProcessEnv): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parseEnv(contents))) {
    if (!PROVIDER_ENVIRONMENT_NAMES.has(key) || environment[key] !== undefined) continue;
    environment[key] = value;
    applied.push(key);
  }
  return applied;
}
