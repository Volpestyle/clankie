# Pokémon play robustness — offline evidence

Scope: VUH-1667, VUH-1668, VUH-1669, VUH-1670 and VUH-1671. No real play
session, paid model request, emulator or live-world mutation ran. Tests use the
AI SDK fixture provider, fake world bodies and temporary settings/journals.

## Results

- 132 focused tests across 12 files passed: the 131-test run plus the added
  missing-price fixture (13 tests in its rerun, with unchanged tests reused).
- Service, play and TUI typechecks passed.
- Changed TypeScript lint, formatting, local Markdown links and retired claims
  passed. OpenAPI YAML parses with the new configuration and guidance paths.

Run heavy checks through `~/.herdr-handoffs/clankie-backlog-20261003/bin/heavy`.
The focused Vitest invocation uses the root `vitest.config.ts` and these files:

```text
packages/play/test/free-play-robustness.test.ts
packages/play/test/free-play.test.ts
packages/play/test/free-play-journal.test.ts
packages/play/test/free-play-mind-timeout.test.ts
packages/play/test/free-play-voice.test.ts
packages/protocol/test/embodiment.test.ts
apps/clankie/test/play-world.test.ts
apps/clankie/test/play-notifications.test.ts
apps/clankie/test/pokemon-play-controls.test.ts
apps/clankie/test/body-play-sessions.test.ts
apps/tui/test/owner-command-layer.test.ts
apps/tui/test/activity-command.test.ts
```

## Behavior proved

The SDK fixture reports cached input, reasoning/output tokens and registry-priced
cost through the mind and voice. Turn/summary journals retain all calls, including
preempted proposals. Usage exhaustion produces `budget_exhausted`; missing prices
stop dollar-capped sessions. API/CLI/TUI fixtures round-trip validated caps.

A continuous room stream permits two preemptions per turn and completes both
turns; later lines remain queued. A 32-slot burst fixture proves ordered retention
and bounded overflow. The queue's existing default behavior remains unchanged
for other consumers, including Minecraft.

Failure fixtures prove exponential backoff, recovery reset, stop during retry,
five-failure termination and its `mind_unavailable` receipt. Battle, menu and dialog
fixtures change state during a proposal and prove that its stale action never
runs. Repeated scene changes end the turn after two fresh proposals.

Stuck and twice-retired objective fixtures emit each kind once. Service fixtures
emit world-ended and model-unavailable notes. Conversation delivery keeps the
original route/grant after the initiating turn and motor lease finish. Revocation
and missing conversations do not redirect information. Play guidance checks its
owner and attachment again after awaiting authority; a competing API conversation
cannot enqueue it.

## Limits and deferred work

Caps apply between model calls; the last call can exceed a threshold. Missing
usage reserves 16,000 charged tokens and leaves estimated cost unknown, rather
than inventing an invoice figure. FIFO overflow merges into the last bounded
slot. Conversation admission gets at most two seconds at termination; unavailable
delivery is logged and never gates play.

VUH-1616 is deferred. These fixes fit the existing Pokémon body seam; completing
the issue's extension contract requires a coordinated Minecraft/Rivals migration
outside this assignment. No Minecraft implementation files changed. Live Discord
and hosted-world delivery remain untested by design; the lead owns landing and
any authorized live validation.
