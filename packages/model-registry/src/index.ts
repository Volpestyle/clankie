import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import bundledSnapshot from "../data/models-dev-snapshot.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Schemas — deliberately lenient. models.dev evolves faster than this package
// ships, so unknown keys pass through (looseObject) and malformed or missing
// values fall back to safe defaults (.catch/.default) instead of throwing.
// ---------------------------------------------------------------------------

export const ModelCostSchema = z.looseObject({
  input: z.number().catch(0).default(0),
  output: z.number().catch(0).default(0),
  cache_read: z.number().catch(0).default(0),
  cache_write: z.number().catch(0).default(0),
});
export type ModelCost = z.infer<typeof ModelCostSchema>;

export const ModelLimitSchema = z.looseObject({
  context: z.number().catch(0).default(0),
  input: z.number().optional(),
  output: z.number().catch(0).default(0),
});
export type ModelLimit = z.infer<typeof ModelLimitSchema>;

export const ModelModalitiesSchema = z.looseObject({
  input: z.array(z.string()).catch([]).default([]),
  output: z.array(z.string()).catch([]).default([]),
});
export type ModelModalities = z.infer<typeof ModelModalitiesSchema>;

export const ModelEntrySchema = z.looseObject({
  id: z.string().catch("").default(""),
  name: z.string().catch("").default(""),
  family: z.string().optional(),
  release_date: z.string().optional(),
  reasoning: z.boolean().catch(false).default(false),
  tool_call: z.boolean().catch(false).default(false),
  temperature: z.boolean().catch(true).default(true),
  attachment: z.boolean().catch(false).default(false),
  cost: ModelCostSchema.catch({ input: 0, output: 0, cache_read: 0, cache_write: 0 }).optional(),
  limit: ModelLimitSchema.catch({ context: 0, output: 0 }).default({ context: 0, output: 0 }),
  modalities: ModelModalitiesSchema.optional(),
  /** models.dev uses "alpha" | "beta" | "deprecated" today; kept open for new values. */
  status: z.string().optional(),
});
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

export const ProviderEntrySchema = z.looseObject({
  id: z.string().catch("").default(""),
  name: z.string().catch("").default(""),
  env: z.array(z.string()).catch([]).default([]),
  npm: z.string().optional(),
  api: z.string().optional(),
  doc: z.string().optional(),
  models: z
    .record(
      z.string(),
      ModelEntrySchema.catch({
        id: "",
        name: "",
        reasoning: false,
        tool_call: false,
        temperature: true,
        attachment: false,
        limit: { context: 0, output: 0 },
      }),
    )
    .catch({})
    .default({}),
});
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;

export const CatalogSchema = z
  .record(z.string(), ProviderEntrySchema.catch({ id: "", name: "", env: [], models: {} }))
  .catch({});
export type Catalog = z.infer<typeof CatalogSchema>;

const CacheEnvelopeSchema = z.object({
  fetchedAt: z.number(),
  catalog: CatalogSchema,
});
type CacheEnvelope = z.infer<typeof CacheEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Bundled snapshot
// ---------------------------------------------------------------------------

let bundledCatalog: Catalog | undefined;

/** Parses the vendored models.dev snapshot shipped with this package. Memoized after first load. */
export function loadBundledCatalog(): Catalog {
  bundledCatalog ??= CatalogSchema.parse(bundledSnapshot);
  return bundledCatalog;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ModelRegistryOptions {
  /** Directory holding the on-disk cache. Defaults to `${XDG_CACHE_HOME ?? ~/.cache}/clankie`. */
  cacheDir?: string;
  /** Catalog origin; `CLANKIE_MODELS_URL` overrides it. Defaults to https://models.dev. */
  url?: string;
  /** How long a cached catalog counts as fresh. Defaults to 5 minutes. */
  ttlMs?: number;
  /** Injected fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected environment; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injected clock for tests; defaults to Date.now. */
  now?: () => number;
}

export type RefreshSource = "network" | "cache" | "bundled";

export interface RefreshResult {
  updated: boolean;
  source: RefreshSource;
}

export interface ModelRegistry {
  /**
   * Resolves a catalog without ever touching the network:
   * `CLANKIE_MODELS_PATH` file → fresh disk cache → stale disk cache (still usable) → bundled snapshot.
   */
  catalog(): Promise<Catalog>;
  /**
   * Fetches `${url}/api.json` and atomically rewrites the disk cache. Without `force` a fresh
   * cache short-circuits. `CLANKIE_DISABLE_MODELS_FETCH` and `CLANKIE_MODELS_PATH` skip the
   * network entirely, and network failures fall back to cache/bundled rather than throwing.
   */
  refresh(force?: boolean): Promise<RefreshResult>;
}

const DEFAULT_URL = "https://models.dev";
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export function createModelRegistry(options: ModelRegistryOptions = {}): ModelRegistry {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const cacheDir = options.cacheDir ?? join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "clankie");
  const cachePath = join(cacheDir, "models.json");
  const baseUrl = (env.CLANKIE_MODELS_URL ?? options.url ?? DEFAULT_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  interface CacheState {
    catalog: Catalog;
    fetchedAt: number;
  }

  async function readCacheState(): Promise<CacheState | undefined> {
    try {
      const raw = JSON.parse(await readFile(cachePath, "utf8")) as unknown;
      const envelope = CacheEnvelopeSchema.safeParse(raw);
      if (envelope.success) return { catalog: envelope.data.catalog, fetchedAt: envelope.data.fetchedAt };
      // Envelope-less cache written by something else: trust the file mtime instead.
      const catalog = CatalogSchema.parse(raw);
      const { mtimeMs } = await stat(cachePath);
      return { catalog, fetchedAt: mtimeMs };
    } catch {
      return undefined;
    }
  }

  async function readExplicitCatalog(): Promise<Catalog | undefined> {
    const explicitPath = env.CLANKIE_MODELS_PATH;
    if (!explicitPath) return undefined;
    try {
      const raw = JSON.parse(await readFile(explicitPath, "utf8")) as unknown;
      const envelope = CacheEnvelopeSchema.safeParse(raw);
      if (envelope.success) return envelope.data.catalog;
      return CatalogSchema.parse(raw);
    } catch {
      return undefined;
    }
  }

  async function writeCacheAtomically(envelope: CacheEnvelope): Promise<void> {
    await mkdir(cacheDir, { recursive: true });
    const tmpPath = `${cachePath}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(envelope), "utf8");
    await rename(tmpPath, cachePath);
  }

  const isFresh = (state: CacheState): boolean => now() - state.fetchedAt < ttlMs;

  const fetchDisabled = (): boolean => {
    const flag = env.CLANKIE_DISABLE_MODELS_FETCH;
    return flag !== undefined && flag !== "" && flag !== "0" && flag.toLowerCase() !== "false";
  };

  return {
    async catalog(): Promise<Catalog> {
      const explicit = await readExplicitCatalog();
      if (explicit) return explicit;
      const cached = await readCacheState();
      if (cached) return cached.catalog; // Stale beyond TTL still beats the older bundled snapshot.
      return loadBundledCatalog();
    },

    async refresh(force = false): Promise<RefreshResult> {
      const explicit = await readExplicitCatalog();
      if (explicit) return { updated: false, source: "cache" };
      const cached = await readCacheState();
      if (fetchDisabled()) return { updated: false, source: cached ? "cache" : "bundled" };
      if (!force && cached && isFresh(cached)) return { updated: false, source: "cache" };
      try {
        const response = await fetchImpl(`${baseUrl}/api.json`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`models.dev responded ${response.status}`);
        const catalog = CatalogSchema.parse(await response.json());
        await writeCacheAtomically({ fetchedAt: now(), catalog });
        return { updated: true, source: "network" };
      } catch {
        return { updated: false, source: cached ? "cache" : "bundled" };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Query helpers — pure functions over a Catalog
// ---------------------------------------------------------------------------

export function listProviders(catalog: Catalog): ProviderEntry[] {
  return Object.values(catalog).sort((a, b) => a.name.localeCompare(b.name));
}

/** Models for a provider, newest release_date first; undated models sort last. */
export function listModels(catalog: Catalog, providerId: string): ModelEntry[] {
  const provider = catalog[providerId];
  if (!provider) return [];
  return Object.values(provider.models).sort((a, b) => {
    const left = a.release_date ?? "";
    const right = b.release_date ?? "";
    if (left !== right) return right.localeCompare(left);
    return a.id.localeCompare(b.id);
  });
}

export function findModel(catalog: Catalog, providerId: string, modelId: string): ModelEntry | undefined {
  return catalog[providerId]?.models[modelId];
}

export interface ModelMatch {
  provider: ProviderEntry;
  model: ModelEntry;
}

/** Case-insensitive substring search over provider id/name and model id/name. */
export function searchModels(catalog: Catalog, query: string): ModelMatch[] {
  const needle = query.toLowerCase();
  const matches: ModelMatch[] = [];
  for (const provider of listProviders(catalog)) {
    const providerHit =
      provider.id.toLowerCase().includes(needle) || provider.name.toLowerCase().includes(needle);
    for (const model of Object.values(provider.models)) {
      if (
        providerHit ||
        model.id.toLowerCase().includes(needle) ||
        model.name.toLowerCase().includes(needle)
      ) {
        matches.push({ provider, model });
      }
    }
  }
  return matches;
}

export function supportsReasoning(model: ModelEntry): boolean {
  return model.reasoning;
}

export function contextWindow(model: ModelEntry): number {
  return model.limit.context;
}

// ---------------------------------------------------------------------------
// Custom providers — user-config entries merged over the catalog
// ---------------------------------------------------------------------------

export type CustomModelEntry = Partial<ModelEntry>;

export type CustomProviderEntry = Omit<Partial<ProviderEntry>, "models"> & {
  models?: Record<string, CustomModelEntry>;
};

export type CustomProviders = Record<string, CustomProviderEntry>;

/**
 * Merges user-config custom providers/models over a catalog (e.g. an "ollama" provider whose
 * models are unknown to models.dev). Custom entries create or override providers and models,
 * deep-merging model fields. Returns a new catalog; the input is not mutated.
 */
export function applyCustomProviders(catalog: Catalog, custom: CustomProviders): Catalog {
  const merged: Catalog = { ...catalog };
  for (const [providerId, patch] of Object.entries(custom)) {
    const base = merged[providerId];
    const { models: modelPatches, ...providerFields } = patch;
    const provider = ProviderEntrySchema.parse({
      name: providerId,
      ...base,
      ...defined(providerFields),
      id: providerId,
      models: {},
    });
    provider.models = { ...base?.models };
    for (const [modelId, modelPatch] of Object.entries(modelPatches ?? {})) {
      provider.models[modelId] = mergeModel(provider.models[modelId], modelPatch, modelId);
    }
    merged[providerId] = provider;
  }
  return merged;
}

function mergeModel(base: ModelEntry | undefined, patch: CustomModelEntry, modelId: string): ModelEntry {
  return ModelEntrySchema.parse({
    name: modelId,
    ...base,
    ...defined(patch),
    id: modelId,
    limit: { ...base?.limit, ...defined(patch.limit ?? {}) },
    ...(base?.cost || patch.cost ? { cost: { ...base?.cost, ...defined(patch.cost ?? {}) } } : {}),
    ...(base?.modalities || patch.modalities
      ? { modalities: { ...base?.modalities, ...defined(patch.modalities ?? {}) } }
      : {}),
  });
}

/** Drops explicitly-undefined keys so a sparse patch never clobbers existing values. */
function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
