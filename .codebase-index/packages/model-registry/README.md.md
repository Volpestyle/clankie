# packages/model-registry/README.md

Documents the catalog resolution order
(CLANKIE_MODELS_PATH → fresh cache → stale cache
→ bundled snapshot), the refresh/atomic-cache
behavior, the env overrides
(CLANKIE_MODELS_URL / CLANKIE_DISABLE_MODELS_FETCH
/ CLANKIE_MODELS_PATH), and the one-liner for
re-vendoring the snapshot from models.dev.
