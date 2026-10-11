# Private lead-chat roster (VUH-2003)

Tracks: https://linear.app/vuhlp/issue/VUH-2003

Focused verification baseline: `2c811fdb65a44b55c79c285a35de136317d7c38e`.

VUH-1950 already shipped lead-to-lead `message_seat` delivery. Per the approved
scope, this change reuses that transport and adds the missing sibling discovery.
Private operator `get_self_state` and the session fleet card now project the
default lead and configured project-chat routes. The projection includes project,
workspace, machine, native seat or service holder, activity history, current
bridge state, and a conversation-ID target for `message_seat`. A stored timestamp
does not imply a live receiver. Worker, child and room conversations are excluded;
Discord gets no roster. The card refreshes at service turn start and each native
prompt read. The lead skill and CLI guide describe the same contract.

Verification through `clankie heavy`:

- `pnpm exec vitest run apps/clankie/test/lead-messages.integration.test.ts apps/clankie/test/lane-mcp.test.ts`: exit 0, 26 tests / two files passed, 22.97 seconds.
- `pnpm --filter @clankie/clankie typecheck`: exit 0.
- `pnpm exec oxfmt --write` on the six changed code/skill/guide files: exit 0.

[Verification capture](clankie://evidence/sha256/b0ca205a90cd0f61f99ab9c4ef6860613b14fd2f757e5919c7fd83f0090de636)
includes the tested source, implementation diff and check outputs.

The integration tests use the real conversation/settings stores, self-state tool,
prompt assembly, native channel pump and delivery acknowledgments. A fixture Herdr
census supplies local and remote seat identity; no live seats or model turns run.
They discover a sibling from self-state, send through its advertised target, and
verify acknowledged delivery without worker adoption. They also verify disconnected,
current and legacy stale receivers, a service-held lead, and the worker/room/Discord
privacy boundary. Existing delivery/restart cases remain green.

Earlier failing iterations are retained in the capture, including fixture mistakes
and the corrected remote-machine join. Only the final run is passing evidence.
No live service ports, simulators, model evals or deployments were used.

Per lead direction, integrate's exact-tree gate is authoritative; no duplicate
local root gate runs. Landing and closure remain pending.
