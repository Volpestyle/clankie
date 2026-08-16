# packages/model-registry/data

Holds `models-dev-snapshot.json` (~3 MB), the
vendored copy of the models.dev catalog bundled
as the last-resort fallback when neither an
explicit catalog file nor a disk cache exists.
Re-vendor with
`curl https://models.dev/api.json > data/models-dev-snapshot.json`.
