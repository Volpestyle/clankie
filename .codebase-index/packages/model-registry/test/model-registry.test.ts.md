# packages/model-registry/test/model-registry.test.ts

Registry tests: the bundled snapshot loads with
known providers; catalog() falls back to bundled
with an empty cache dir; refresh(true) writes the
cache which catalog() then serves; stale caches
stay usable past TTL; the disable-fetch, explicit
path, and URL-override env vars behave; failed
refreshes fall back to stale cache. Query-helper
sorting/search, applyCustomProviders (new ollama
provider; deep-merged overrides), and lenient
parsing of unknown/malformed catalog data.
