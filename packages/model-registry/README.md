# @clankie/model-registry

Model catalog service backed by [models.dev](https://models.dev). It ships a vendored snapshot of the models.dev catalog, keeps an optional on-disk cache fresh, and merges user-configured custom providers (e.g. a local Ollama endpoint models.dev knows nothing about).

Schemas are lenient by design: unknown keys pass through and malformed or missing fields fall back to safe defaults, so a models.dev format change never breaks catalog loading.

## Resolution order

`createModelRegistry().catalog()` never touches the network. It resolves, in order:

1. `CLANKIE_MODELS_PATH` — an explicit catalog file wins over everything.
2. Fresh disk cache — `<cacheDir>/models.json` within the TTL (default 5 minutes).
3. Stale disk cache — still usable, just past the TTL.
4. Bundled snapshot — [`data/models-dev-snapshot.json`](data/models-dev-snapshot.json).

The default cache dir is `${XDG_CACHE_HOME ?? ~/.cache}/clankie`.

## Refreshing

`registry.refresh(force?)` fetches `${url}/api.json` (10 s timeout) and atomically rewrites the disk cache as a `{ fetchedAt, catalog }` envelope. Without `force`, a fresh cache short-circuits. Network failures fall back to cache or the bundled snapshot instead of throwing.

## Environment overrides

- `CLANKIE_MODELS_URL` — catalog origin (default `https://models.dev`).
- `CLANKIE_DISABLE_MODELS_FETCH` — skip the network entirely; serve cache or bundled.
- `CLANKIE_MODELS_PATH` — explicit catalog file; wins over cache, network, and bundled.

## Re-vendoring the snapshot

```sh
curl https://models.dev/api.json > packages/model-registry/data/models-dev-snapshot.json
```

Run that command from the repository root. Last vendored 2026-09-26.

The bundled costs are what model-key telemetry prices calls with, so the models
hosted plans and routing name are pinned to the provider's published prices in
`test/model-registry.test.ts`: `gpt-6-luna`, `gpt-6-astra`, `gpt-5.6-luna` and
`gpt-5.4-nano`, checked against [OpenAI's pricing page](https://developers.openai.com/api/docs/pricing).
A re-vendor that moves one of them fails the test. Check the page: update the
pin if the provider changed its price, or keep the old snapshot if models.dev
is wrong. The previous snapshot listed `gpt-5.6-luna` at 5x its price.
