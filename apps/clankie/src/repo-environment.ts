import { parseEnv } from "node:util";
import { loadBundledCatalog } from "@clankie/model-registry";

const PROVIDER_ENVIRONMENT_NAMES = new Set(
  Object.values(loadBundledCatalog()).flatMap((provider) => provider.env ?? []),
);

/** Apply only the provider API-key fallbacks `.env.local` is documented to hold. */
export function applyRepoProviderEnvironment(contents: string, environment: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(parseEnv(contents))) {
    if (!PROVIDER_ENVIRONMENT_NAMES.has(key) || environment[key] !== undefined) continue;
    environment[key] = value;
  }
}
