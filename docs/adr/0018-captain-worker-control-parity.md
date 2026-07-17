# ADR 0018: The captain controls workers through the operator command surface

Status: accepted (James, 2026-07-11).

## Decision

Clankie's captain controls its subagent workers through the **same command surface a human operator uses** — worker-pane slash commands (`/goal`, `/model`, `/effort`, plain steering text) and the console's typed verbs — not a captain-only control API. Capability parity is the contract: anything a human can do to configure, arm, or steer a worker from the TUI or its pane, the captain can do the same way, explicitly including arming a harness's native `/goal` completion loop at delegation time.

## Rationale

- **No hidden control plane.** Every captain action on a worker is visible, attributable, and replayable on the stage — the same property the embodiment thesis demands of the workers themselves. A human watching the pane sees exactly how the captain drove it.
- **Symmetric run control.** Humans inspect and take over a worker's run mid-flight using the vocabulary the captain was already using; nothing must be translated between a "human surface" and an "agent API" when a human steps in.
- **One vocabulary, two transports.** Pane-hosted harness workers (Claude Code, Codex, OpenCode CLIs) receive literal slash commands. Adapter-hosted workers (Codex App Server, Claude Agent SDK, Pi — ADR 0006) expose the same operator vocabulary mapped onto their protocol methods; the mission engine owns their turn loop, so a `/goal` equivalent is the task-lifecycle contract rather than an injected command. The command set stays one vocabulary either way.
- **No second API to build or drift.** The operator surface is already doctrine-checked and audited; a parallel captain-only path would need the same policy plumbing twice.

## Boundaries

- Parity covers configuration and steering, not authority: approvals and other privileged actions stay on authenticated surfaces per the `AGENTS.md` privileged-action list and ADR 0010 — the captain requesting them and a human granting them are different acts on different surfaces.
- Captain input into a worker pane is attributed to the captain identity and is serialized under the same single terminal write grant as human input (docs/05 "Terminal input authority"). Steering itself is typed control-plane intent, not raw terminal bytes, and is not gated by who holds that grant (ADR 0036).
- Persona never widens this surface (ADR 0010): what the captain may send is bounded by doctrine and write scope, not by `soul.md`.

## Options weighed

A captain-only worker-control RPC (richer, typed, no terminal round-trip) was rejected: it duplicates policy enforcement, hides captain behavior from the stage, and breaks the parity that makes supervised self-development (ADR 0017) auditable. Protocol-native adapter transports are kept — they are the same vocabulary on a different wire, not a second control plane.
