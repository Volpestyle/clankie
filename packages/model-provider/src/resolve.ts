import {
  applyCustomProviders,
  findModel,
  type Catalog,
  type CustomModelEntry,
  type CustomProviders,
  type ModelEntry,
  type ProviderEntry,
} from "@clankie/model-registry";
import { parseModelRef, type ClankieConfig } from "./config.ts";
import { withCodexSubscriptionProvider } from "./codex-catalog.ts";

// ---------------------------------------------------------------------------
// Catalog merging — config-declared providers/models overlaid on the registry
// catalog. Only catalog-shaped data crosses over (name/env/npm/models);
// `options` (baseURL, timeouts, …) is connection config, not catalog data,
// and stays config-side for instantiation to consume.
// ---------------------------------------------------------------------------

export function mergedCatalog(config: ClankieConfig, catalog: Catalog): Catalog {
  catalog = withCodexSubscriptionProvider(catalog);
  const providerConfigs = config.provider;
  if (providerConfigs === undefined || Object.keys(providerConfigs).length === 0) return catalog;
  const custom: CustomProviders = {};
  for (const [providerId, providerConfig] of Object.entries(providerConfigs)) {
    custom[providerId] = {
      ...(providerConfig.name !== undefined && { name: providerConfig.name }),
      ...(providerConfig.env !== undefined && { env: providerConfig.env }),
      ...(providerConfig.npm !== undefined && { npm: providerConfig.npm }),
      ...(providerConfig.models !== undefined && {
        models: providerConfig.models as Record<string, CustomModelEntry>,
      }),
    };
  }
  return applyCustomProviders(catalog, custom);
}

// ---------------------------------------------------------------------------
// Provider resolution — which providers exist, which are usable, and how.
// ---------------------------------------------------------------------------

export type ProviderConnection = "credential" | "env" | "none";

export interface ResolvedProvider {
  id: string;
  name: string;
  entry: ProviderEntry;
  connected: boolean;
  connection: ProviderConnection;
  declaredInConfig: boolean;
}

export interface ResolveProvidersInput {
  config: ClankieConfig;
  catalog: Catalog;
  /** Provider ids that have a stored credential (from the credential broker's `list()`). */
  credentialIds: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the provider list from the merged catalog: `disabled_providers`
 * are dropped, a non-empty `enabled_providers` acts as an allowlist, and each
 * survivor is marked connected when the credential broker holds a credential
 * for it or one of its declared env vars is set. Connected providers sort
 * first; ties break by display name.
 */
export function resolveProviders(input: ResolveProvidersInput): ResolvedProvider[] {
  const env = input.env ?? process.env;
  const catalog = mergedCatalog(input.config, input.catalog);
  const disabled = new Set(input.config.disabled_providers ?? []);
  const enabled = input.config.enabled_providers ?? [];

  const resolved: ResolvedProvider[] = [];
  for (const entry of Object.values(catalog)) {
    if (disabled.has(entry.id)) continue;
    if (enabled.length > 0 && !enabled.includes(entry.id)) continue;
    const connection: ProviderConnection = input.credentialIds.includes(entry.id)
      ? "credential"
      : entry.env.some((name) => (env[name] ?? "") !== "")
        ? "env"
        : "none";
    resolved.push({
      id: entry.id,
      name: entry.name,
      entry,
      connected: connection !== "none",
      connection,
      declaredInConfig: input.config.provider?.[entry.id] !== undefined,
    });
  }
  return resolved.sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ---------------------------------------------------------------------------
// Role resolution — which concrete model a configured role points at.
// ---------------------------------------------------------------------------

export type ModelRole = "model" | "small_model" | "voice_model" | "settle_classifier_model";

export interface ResolvedRole {
  providerId: string;
  modelId: string;
  /** Catalog entry when the ref resolves; undefined for models the catalog does not know. */
  model: ModelEntry | undefined;
  /** Variant selected for this ref via `config.variant`, if any. */
  variantId: string | undefined;
}

export function resolveRole(
  role: ModelRole,
  input: { config: ClankieConfig; catalog: Catalog },
): ResolvedRole | undefined {
  const ref = input.config[role];
  if (ref === undefined) return undefined;
  const parsed = parseModelRef(ref);
  if (parsed === undefined) return undefined;
  const catalog = mergedCatalog(input.config, input.catalog);
  return {
    providerId: parsed.providerId,
    modelId: parsed.modelId,
    model: findModel(catalog, parsed.providerId, parsed.modelId),
    variantId: input.config.variant?.[ref],
  };
}
