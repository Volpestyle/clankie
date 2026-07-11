# Eve captain

This is the lead-agent runtime. Eve supplies durable sessions, filesystem-authored instructions, tools, skills, channels, and bounded subagents. Sapling keeps mission scheduling, action policy, runner state, and the versioned event protocol outside Eve so clients and workers are not coupled to a beta framework API.

The only authored tools call a narrow control-plane API. They do not expose a generic application-runtime shell or raw credentials.

The service resolves the captain model dynamically from layered Clankie config
through `@sapling/model-provider`. Provider credentials remain behind the local
credential broker; the TUI sees only Eve session events. The built-in Eve
shell, filesystem, and web tools are explicitly disabled, leaving the authored
mission tools plus framework coordination primitives.

Run the headless service directly when developing the TUI without the
`clankie` launcher:

```bash
pnpm --filter @sapling/captain-eve exec eve build
pnpm --filter @sapling/captain-eve exec eve start --host 127.0.0.1 --port 4321
SAPLING_CAPTAIN_URL=http://127.0.0.1:4321 pnpm --filter @sapling/tui dev
```

Use `eve dev --no-ui` only while editing the authored captain itself. The shared
operator service uses built output so a process restart never leaves a durable
session pointing at a pruned development snapshot.

Eve owns durable conversation execution, replay, and compaction. Clients store
only their continuation/session cursor. Mission state remains authoritative in
the control plane.

## Skill verification

`pnpm --filter @sapling/captain-eve test` compiles the authored Eve surface without provider credentials and verifies that all mission skills are discovered. `pnpm --filter @sapling/captain-eve exec eve eval --list` validates the behavior-eval definitions.

With captain model credentials configured, run `pnpm --filter @sapling/captain-eve exec eve eval skills --strict` to verify that mission-shaped prompts load the matching skill and an unrelated prompt does not load one.
