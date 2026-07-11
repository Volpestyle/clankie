# Eve captain

This is the lead-agent runtime. Eve supplies durable sessions, filesystem-authored instructions, tools, skills, channels, and bounded subagents. Sapling keeps mission scheduling, action policy, runner state, and the versioned event protocol outside Eve so clients and workers are not coupled to a beta framework API.

The only authored tools call a narrow control-plane API. They do not expose a generic application-runtime shell or raw credentials.

## Skill verification

`pnpm --filter @sapling/captain-eve test` compiles the authored Eve surface without provider credentials and verifies that all mission skills are discovered. `pnpm --filter @sapling/captain-eve exec eve eval --list` validates the behavior-eval definitions.

With captain model credentials configured, run `pnpm --filter @sapling/captain-eve exec eve eval skills --strict` to verify that mission-shaped prompts load the matching skill and an unrelated prompt does not load one.
