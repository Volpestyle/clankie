# packages/model-provider/src/config.ts

Layered clankie configuration.

- `ClankieConfigSchema` — loose (unknown keys
  pass through) covering model role refs (model /
  small_model / voice_model /
  settle_classifier_model / image_model /
  video_model), per-ref `variant` selections,
  enabled/disabled providers, and `provider`
  declarations (name/npm/env/options/models). A
  recursive superRefine rejects secret-shaped
  keys anywhere in the tree (authorization,
  *apikey, token, secret), pointing at /auth and
  the credential broker.
- `loadConfig()` — reads the global file
  (`~/.config/clankie/clankie.json` via
  `globalConfigPath`) then the nearest repo
  `.clankie.json` walking up from cwd
  (`findRepoConfigPath`), deep-merging repo over
  global (objects merge, arrays/scalars replace).
  Never throws: bad files become `issues` and are
  skipped.
- `updateGlobalConfig(mutate)` — global file
  only; mutate in place or return a replacement;
  validated, atomic (temp + rename, pretty JSON),
  serialized in-process. A corrupt global file is
  a hard error, never overwritten.
- Model refs — `parseModelRef` splits
  "providerId/modelId" on the _first_ slash
  (model ids may contain slashes);
  `formatModelRef` is its inverse.
