# Development guide

## Toolchain

- Node 24+
- pnpm 11+
- TypeScript 5.9
- Turbo
- Vitest
- oxlint and oxfmt
- Xcode for iOS/macOS shells
- optional JDK 21 for the Minecraft Paper verifier lab (`integrations/minecraft-paper-verifier`); without it the aggregate eval lane skips that build with a notice
- optional Docker for local telemetry/sandboxes
- optional Codex CLI, Pi coding agent, and provider credentials

Run:

```bash
corepack enable
pnpm install
pnpm doctor
pnpm check
```

## Local service ports

- control plane: `4310`
- development relay: `4320`
- captain Eve session API: `4321`
- OTLP HTTP: `4318`
- local telemetry UI: see `infra/observability/README.md`

## Start the offline proof

```bash
pnpm eval:self-build
```

## Start operator surfaces

```bash
clankie
```

The launcher attaches to or starts the loopback captain service before opening
the TUI. For separate development processes:

```bash
pnpm --filter @clankie/control-plane dev
pnpm --filter @clankie/captain-eve exec eve build
pnpm --filter @clankie/captain-eve exec eve start --host 127.0.0.1 --port 4321
CLANKIE_CAPTAIN_URL=http://127.0.0.1:4321 pnpm --filter @clankie/tui dev
```

### Headless captain control

The installed `clankie` executable also provides non-interactive commands. They
do not initialize the fullscreen face and work with piped stdin/stdout:

```bash
clankie health
clankie status
clankie restart
clankie msg "Inspect the current mission and report the next action."
printf '%s\n' "Inspect the current mission." | clankie msg
clankie watch --timeout 600
clankie wait --timeout 600
```

`health` and `status` perform the canonical identity probe: first
`GET /eve/v1/health`, then `GET /eve/v1/info`. They print one JSON record and
never start a missing service. The Eve server does not expose `GET /health`; a
404 from that path is not evidence that port 4321 is squatted or stale. The
equivalent manual probe is:

```bash
curl --fail --silent http://127.0.0.1:4321/eve/v1/health
curl --fail --silent http://127.0.0.1:4321/eve/v1/info
```

`restart` signals only a service whose mode-0600 launcher record and live
process command agree. This deliberately permits an older launcher-owned build
to be replaced after the current Eve identity contract changes. It refuses to
signal an unowned or unidentified listener and prints the exact `lsof`
inspection command instead. When no service is reachable, it builds and starts
the durable captain normally.

`msg` submits a turn without echoing its message and records an isolated
mode-0600 cursor under `${XDG_STATE_HOME:-~/.local/state}/clankie/`; it never
shares the fullscreen TUI cursor. `watch` prints replay-safe semantic events as
JSONL and checkpoints after every event. `wait` suppresses intermediate events
and prints the final session boundary. Both return 124 on an explicit timeout.
If a prior active cursor belongs to another captain generation, inspect mission
state and use `clankie msg --new ...` to abandon it explicitly.

The TUI is built against `@earendil-works/pi-tui`, not Ink or a generic abstraction. Custom components must return lines no wider than the supplied width and should use the framework utilities for ANSI-aware truncation.

## Real provider readiness

```bash
codex --version
pi --version
printenv ANTHROPIC_API_KEY >/dev/null
```

Run provider contract smoke tests in disposable worktrees before enabling them in a mission. Keep provider integration tests opt-in and exclude them from credential-free CI.

`openai/<model>` uses an OpenAI API key. `openai-codex/<model>` uses the
ChatGPT subscription OAuth credential and the Codex Responses transport. The
provider identity is explicit so both credentials can coexist safely.

## Command-center product app

Graphical operator UI (Expo mobile shell, bare macOS shell, shared `@clankie/command-center` source, garden pixel art, and the sprite pipeline) lives in the **private** product monorepo `Volpestyle/clankie-app` — not this agent OS tree.

This repository keeps the public contracts the app consumes (`@clankie/protocol`, `@clankie/terminal-protocol`, `@clankie/garden-model`) plus the TUI and backend surfaces. Product UI, art, and shell write scope: label `clankie-app` on Linear (hub [VUH-817](https://linear.app/vuhlp/issue/VUH-817)).

## Concurrent work through the tracker (interim)

This is the scaffolding-phase protocol ([ADR 0017](adr/0017-self-development-operating-model.md)): external agent sessions lead build waves until Clankie's captain takes the lead seat after the M2 gate. Until the tracker connector lands ([VUH-764](https://linear.app/vuhlp/issue/VUH-764)), concurrent agent sessions coordinate on Linear directly under these rules:

- All agent sessions post as the single shared identity (`volpestyle+clanky@gmail.com`) — never a personal account or a per-agent seat. Sign every comment with agent name, role, and worker/session ID.
- Claim before starting: self-assign the issue and move it to In Progress, then re-read the issue to confirm the claim stuck. If another session claimed it first, pick a different issue.
- One issue per worker, one autonomous writer per worktree; declared write scopes must not overlap (`AGENTS.md`).
- Report results as issue comments using the completed-implementation evidence block from `AGENTS.md`.
- Workers own all tracker narrative by default: evidence blocks, verification verdicts, blockers, and closure/landing summaries (the lead hands the worker the landing commit and observed gate results to include). The lead writes only terse authority acts — rulings, documented exceptions, scope grants, and status-transition flags.
- The lead session verifies against acceptance criteria and transitions issues to Done; an implementer never marks its own issue completed.
- The duty split above is the scaffolding-phase default, not doctrine: for Clankie it is an operator-configurable ceremony setting (the operator decides what the lead posts versus what workers post), tracked with the doctrine ceremony presets ([VUH-747](https://linear.app/vuhlp/issue/VUH-747)).

The tracker is authority for intent, priority, and acceptance criteria only. It is not a coordination mutex — conflict prevention lives in write scopes and worktree isolation.

## Linear captain channel

The Linear agent channel is a bounded ambient conversation surface, not an approval or tracker-authority surface. Hosted ingress verifies exact webhook bytes under a hard 4.5-second response deadline, preserves `Linear-Delivery`, and makes deliveries available to the local outbound bridge. Stalled bodies are cancelled and receive a retryable non-2xx response before Linear's five-second limit. The local bridge independently verifies the signature and roughly 60-second timestamp window, then passes the typed event to `apps/linear-bridge`.

The channel adapter schedules a visible thought acknowledgement before any Eve turn, with a 10-second target from ingress receipt. It rechecks human/app/session/issue identity, deduplicates deliveries, and applies issue/workspace caps. The loopback control plane retains the doctrine narrative evaluator, reads the full Linear thread through the broker-backed runtime, and submits the turn through Eve. Settled text becomes a response activity; a real input request becomes an elicitation. Approval-shaped input or output becomes a refusal linking to the authenticated approval surface.

The bridge receives no OAuth, model, mission-state, tracker-mutation, or privileged-action credential. Human setup is limited to the owner-managed Linear OAuth app/install, broker insertion, durable hosted outbound transport, trusted runtime module configuration, and an opt-in disposable-issue smoke. See [`../apps/linear-bridge/README.md`](../apps/linear-bridge/README.md).

Run the local composition with `pnpm --filter @clankie/linear-bridge start`. Configure the loopback control-plane URL, authenticated approval surface, webhook signing secret, bounded mission identity fields, and an absolute `CLANKIE_LINEAR_TRANSPORT_MODULE` whose `createLinearWebhookOutboundTransport()` factory privately owns the authenticated outbound connection. The bridge process itself receives no Linear OAuth, tracker-write, model, runner, captain, operator, or privileged-connector credential.

## Adding a package

- use `@clankie/<name>`;
- expose TypeScript source during scaffold stage;
- include `typecheck`, `test`, and `clean` scripts;
- obey dependency direction in the architecture check;
- add unit tests for invariants, not just happy paths;
- document authority/security implications.

## Adding a skill

Skills live once under `.agents/skills` (the source of truth). The provider roots
`.claude/skills`, `.codex/skills`, and `.pi/agent/skills` mirror it with relative
symlinks, so they cannot drift — see [ADR 0008](adr/0008-symlinked-provider-skill-mirror.md).

- author or edit the skill under `.agents/skills/<name>`;
- run `pnpm skills:sync` to wire the mirrors and prune stale links;
- `pnpm check` runs `pnpm skills:check`, which fails if any mirror is not the
  correct symlink — never edit a provider copy directly.
