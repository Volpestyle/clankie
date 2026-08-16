# packages/model-registry

`@clankie/model-registry` — the model catalog,
backed by models.dev. Ships a vendored snapshot,
keeps an optional on-disk cache fresh, and
exposes pure query helpers plus a merge hook for
user-configured custom providers (e.g. a local
Ollama endpoint models.dev knows nothing about).

Children:

- README.md — resolution order, refresh, env vars
- data/ — vendored models.dev snapshot (3 MB)
- src/ — `index.ts`, the whole package
- test/ — registry + query + leniency suites
- package.json / tsconfig.json — zod-only, ESM

Key behaviors: `catalog()` never touches the
network (explicit path → fresh cache → stale
cache → bundled snapshot); `refresh()` fetches
`api.json` with a 10 s timeout and atomically
rewrites the cache, falling back rather than
throwing. Schemas are deliberately lenient —
unknown keys pass through and malformed fields
default — so a models.dev format change never
breaks loading.
