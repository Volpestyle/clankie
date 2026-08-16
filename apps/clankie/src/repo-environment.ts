import { loadBundledCatalog } from "@clankie/model-registry";

const PROVIDER_ENVIRONMENT_NAMES = new Set(
  Object.values(loadBundledCatalog()).flatMap((provider) => provider.env ?? []),
);

/** Apply only the provider API-key fallbacks `.env.local` is documented to hold. */
export function applyRepoProviderEnvironment(contents: string, environment: NodeJS.ProcessEnv): void {
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!PROVIDER_ENVIRONMENT_NAMES.has(key) || environment[key] !== undefined) continue;
    const raw = trimmed.slice(separator + 1).trim();
    environment[key] =
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
  }
}
