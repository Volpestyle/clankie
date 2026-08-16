# packages/model-registry

Cached, queryable models.dev catalog used by model resolution. It validates lenient upstream data, prefers fresh network/disk data with stale and bundled fallback, and never places provider credentials in the catalog.

- `data/` — bundled models.dev snapshot.
- `package.json` — registry dependencies and scripts.
- `README.md` — cache and refresh behavior.
- `src/` — schemas, loading, caching, and query helpers.
- `test/` — fallback and query tests.
- `tsconfig.json` — TypeScript configuration.
