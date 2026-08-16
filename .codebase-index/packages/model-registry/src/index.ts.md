# packages/model-registry/src/index.ts

The whole registry, in four parts:

- Schemas — `ModelEntrySchema`,
  `ProviderEntrySchema`, `CatalogSchema`, all
  `looseObject` with `.catch`/`.default` on every
  field: models.dev evolves faster than this
  package ships, so unknown keys pass through and
  malformed values fall back instead of throwing.
- Registry — `createModelRegistry(options)`
  returns `{catalog, refresh}`. `catalog()` never
  touches the network: `CLANKIE_MODELS_PATH` file
  → disk cache (fresh or stale — stale still
  beats the older bundled snapshot) → memoized
  bundled snapshot (`loadBundledCatalog`).
  `refresh(force?)` fetches `${url}/api.json`
  (10 s timeout, `CLANKIE_MODELS_URL` override,
  `CLANKIE_DISABLE_MODELS_FETCH` opt-out) and
  atomically rewrites
  `${XDG_CACHE_HOME:-~/.cache}/clankie/models.json`
  as a `{fetchedAt, catalog}` envelope; failures
  fall back to cache/bundled. Envelope-less cache
  files fall back to mtime for freshness.
- Query helpers — pure functions over a Catalog:
  `listProviders` (name-sorted), `listModels`
  (newest release_date first), `findModel`,
  `searchModels` (case-insensitive substring over
  provider/model id+name), `supportsReasoning`,
  `contextWindow`.
- Custom providers — `applyCustomProviders`
  merges user-config provider/model patches over
  the catalog (deep-merging model fields,
  dropping explicitly-undefined keys so sparse
  patches never clobber), returning a new
  catalog.
