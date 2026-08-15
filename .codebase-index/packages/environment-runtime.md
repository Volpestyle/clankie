# packages/environment-runtime

Service-owned lifecycle and lease enforcement for
durable interactive environments (Minecraft, the
PokeMMO simulator, the GBA emulator). Adapters
implement start/attach/pause/resume/action/stop
against the strict contracts from
`@clankie/interactive-environment`; this package
owns the durable state, the one-writer lease, and
idempotent action dispatch.

Children:

- `README.md` — model overview + mermaid diagram
- `package.json` — @clankie/environment-runtime
- `src/` — `EnvironmentRuntime` and its types
- `test/` — fake-adapter contract suite
- `tsconfig.json` — standard noEmit config

Core guarantees (all in `src/runtime.ts`):

- Exactly one unexpired writer lease per
  character/world pair; use renews the lease, an
  idle lapse pauses the body and `renew` resumes
  it, revocation (stop/emergency/failure) is final.
- Action ids are registered before adapter
  dispatch, so retries/restarts return the
  recorded result instead of repeating side
  effects; deadlines cancel wedged actions.
- Emergency stop needs no token, runs off the
  shared queue, and fences synchronously.
- Capability tokens and connection credentials
  stay in memory; durable JSON records hold only a
  token hash, and all output is recursively
  redacted against the per-session secret set.
- Dual-reads legacy v1 (Minecraft-shaped) session
  records, single-writes v2; optional retention
  bounds action records and ended sessions.
