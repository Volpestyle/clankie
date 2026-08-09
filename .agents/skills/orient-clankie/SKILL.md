---
name: orient-clankie
description: Use before the first substantive change in this repository, or whenever the layering, vocabulary, or which file owns a concern is unclear. Maps Clankie's four layers, the invariants that explain most surprises, and the read order for one kind of change.
---

# Orient in Clankie

This repository is the agent OS: the machinery that lets one persistent agent lead
missions and supervise workers. The graphical product app is the private
`clankie-app` repo. [`AGENTS.md`](../../../AGENTS.md) is what you may do; this skill
is what the system is.

## Four layers

Every request crosses the same stack, top to bottom
([architecture](../../../docs/01-architecture.md#system-diagram)):

1. **Ingress** — TUI, Discord text and voice, Slack, Linear, paired devices.
   Normalizes into one captain turn. None of them plans.
2. **Captain (Eve)** — persona, conversation, planning, critique, synthesis. Runs on
   the [Eve](https://eve.dev/docs) framework in `apps/captain-eve`. Owns durable
   sessions and the one authored tool bank; owns no mission state.
3. **Mission control plane** (`apps/control-plane`) — trusted and deterministic:
   event store, DAG scheduler, doctrine, policy, budgets, approvals. Authoritative
   for every fact a model could otherwise assert.
4. **Local runner** (`apps/runner`) — worktrees, PTYs, native provider sessions,
   sandbox, credential exchange, control leases, agent census. Owns execution;
   workers live here.

The captain reaches the control plane through a narrow authenticated API, and the
control plane reaches the runner through a versioned worker protocol. Nothing skips
a layer.

## Six facts that explain most surprises

- **One tool bank.** Every ability lives in `apps/captain-eve/agent/tools/`, pinned by
  `CAPTAIN_AUTHORED_TOOL_NAMES` in `@clankie/protocol`. A branch of Clankie never
  grows its own tools; it either is a captain lane or gets a one-tool handoff into
  one ([one tool bank](../../../docs/01-architecture.md#one-tool-bank)).
- **The captain's shell is the runner's.** `bash` and `read_file` ship the work to
  the runner, which runs it under Seatbelt: reads span the host, writes reach one
  scratchpad, no network ([ADR 0086](../../../docs/adr/0086-clankie-holds-a-shell.md)).
  He still cannot write the repository — a seat that could would edit the doctrine
  it is judged against — and that boundary lives in `apps/runner`, not in him.
- **Model output is untrusted input.** Model text, tool arguments, repository files,
  terminal bytes, downloaded skills, persona content, and worker self-reported
  success are all untrusted; deterministic services and structured events are
  authoritative ([trust boundaries](../../../docs/01-architecture.md#trust-boundaries)).
- **State is event-sourced.** The append-only hash-chained event store is the truth
  and every surface — garden, transcript, status — is a derived projection. Never
  make a client infer state from terminal output.
- **A model cannot grant itself permission.** Privileged actions require a policy
  `allow` and a privileged connector. Merge, deploy, and org-wide credentials never
  enter a worker process.
- **Lanes are isolated.** Each conversation is its own durable Eve session. Lanes
  share a versioned character projection, never continuation tokens; a token
  observed in a second lane fails closed.

## Where a change lives

| Change | Read first | Write in |
| --- | --- | --- |
| Captain ability, instruction, or lane | [`apps/captain-eve/README.md`](../../../apps/captain-eve/README.md) | `apps/captain-eve/agent/` and the pinned name list in `packages/protocol` |
| Policy, authority, routing, ceremony | [`docs/04-doctrine.md`](../../../docs/04-doctrine.md) | `packages/doctrine` plus its policy tests |
| Mission lifecycle, DAG, leasing, approvals | [control flow](../../../docs/01-architecture.md#control-flow) | `packages/mission-engine`, `apps/control-plane` |
| Worker execution, worktrees, PTYs, status | [`docs/05-worker-and-terminal-runtime.md`](../../../docs/05-worker-and-terminal-runtime.md) | `apps/runner`, `packages/worker-*`, `packages/terminal-protocol` |
| Any message crossing a service boundary | — | `packages/protocol` first; versioned and provider-neutral |
| Embodiment (Minecraft, GBA, PokeMMO) | [interactive environments](../../../docs/01-architecture.md#interactive-environments) | `packages/environment-runtime`, `integrations/<name>` |
| Discord presence, voice, perception, memory | [`apps/discord-bridge/README.md`](../../../apps/discord-bridge/README.md) | `apps/discord-bridge`, `packages/discord-presence-core` |
| Garden, graph, terminal deck | [`docs/06-garden-and-graph.md`](../../../docs/06-garden-and-graph.md) and the `garden-control-design` skill | `packages/garden-model` |
| Evaluation, scoring, release gates | [`docs/07-evaluations.md`](../../../docs/07-evaluations.md), [`docs/17-capability-completion-contract.md`](../../../docs/17-capability-completion-contract.md) | `packages/evals`, `apps/lead-agent-lab` |
| Pixel art, garden sprites, app UI | — | the private `clankie-app` repo, not here |

Dependency direction is enforced by `pnpm arch:check`. A cross-package import that
feels natural but fails the check is usually a shared type that belongs in
`packages/protocol`.

## Vocabulary

[`docs/GLOSSARY.md`](../../../docs/GLOSSARY.md) defines the load-bearing terms —
mission, task, worker run, lane, Eve, doctrine, evidence, capability, control lease,
authority role, invariant floor, warmth. The docs use these words precisely and do
not gloss them again at each use, so read it once rather than inferring from context.

## Decisions

`docs/adr/` holds over eighty ADRs and no index, but each filename states the claim
it decided, so search names before reading bodies:

```bash
ls docs/adr | grep -iE "voice|routing|browser"
```

Prefer finding the ADR over inferring intent: behavior that looks arbitrary usually
has a numbered decision behind it. Recording a new decision belongs to the change
that makes it, not to follow-up work.

## Then

Return to [`AGENTS.md`](../../../AGENTS.md): restate the task contract, stay inside
the declared write scope, run the narrowest relevant check first, and report only
evidence you observed in this workspace.
