# @clankie/model-registry

Model catalog service backed by [models.dev](https://models.dev). It ships a vendored snapshot of the models.dev catalog, keeps an optional on-disk cache fresh, and exposes pure query helpers plus a merge hook for user-configured custom providers (e.g. a local Ollama endpoint models.dev knows nothing about).

Schemas are lenient by design: unknown keys pass through and malformed or missing fields fall back to safe defaults, so a models.dev format change never breaks catalog loading.

## Resolution order

`createModelRegistry().catalog()` never touches the network. It resolves, in order:

1. `CLANKIE_MODELS_PATH` — an explicit catalog file wins over everything.
2. Fresh disk cache — `<cacheDir>/models.json` within the TTL (default 5 minutes).
3. Stale disk cache — still usable, just past the TTL.
4. Bundled snapshot — `data/models-dev-snapshot.json`.

The default cache dir is `${XDG_CACHE_HOME ?? ~/.cache}/clankie`.

## Refreshing

`registry.refresh(force?)` fetches `${url}/api.json` (10 s timeout) and atomically rewrites the disk cache as a `{ fetchedAt, catalog }` envelope. Without `force`, a fresh cache short-circuits. Network failures fall back to cache or the bundled snapshot instead of throwing.

## Environment overrides

- `CLANKIE_MODELS_URL` — catalog origin (default `https://models.dev`).
- `CLANKIE_DISABLE_MODELS_FETCH` — skip the network entirely; serve cache or bundled.
- `CLANKIE_MODELS_PATH` — explicit catalog file; wins over cache, network, and bundled.

## Re-vendoring the snapshot

```sh
curl https://models.dev/api.json > data/models-dev-snapshot.json
```
