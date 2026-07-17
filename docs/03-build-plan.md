# Decisive build plan

## Milestone 0 — executable control-loop proof

Already represented by the scaffold.

Deliverables:

- stable schemas for missions, tasks, evidence, approvals, and events;
- doctrine compiler and deny-by-default action policy;
- deterministic scheduler and independent-verifier exclusion;
- simulated heterogeneous self-build scenario;
- scorecard and artifacts;
- event-to-garden projection.

Exit gate: `pnpm check` and self-build evaluation pass from a clean checkout without provider credentials.

## Milestone 1 — trusted local runner

Build next:

- SQLite event store and mission projections;
- Git worktree lifecycle manager;
- PTY manager with sequence replay and snapshots;
- process leases, heartbeats, cancellation, and restart recovery;
- macOS Keychain credential backend;
- capability exchange for GitHub/connector operations;
- shell sandbox profiles and network allowlists;
- native Codex, Claude, and Pi adapter contract tests.

Exit gate: crash the control plane and TUI while three workers run; reconnect and recover exact state without duplicate side effects.

## Milestone 2 — lead agent with real workers

- Eve captain uses narrow mission tools only.
- Planner emits typed plans validated before execution.
- Codex, Claude Agent SDK, and Pi complete the frozen real-provider scenario.
- Verifier is independently selected.
- Debugger receives failure evidence, not the lead’s hidden chain of thought.
- A human approves the final simulated merge in the TUI.

Exit gate: treatment beats single-agent baseline on the initial scenario suite and has zero policy bypasses.

## Milestone 3 — operator-grade TUI and pane integration

- Build on `@earendil-works/pi-tui` components, overlays, key handling, and differential rendering.
- Mission tree, worker roster, event timeline, doctrine editor, approval inbox, and artifact summaries.
- Herdr adapter plus native PTY/tmux fallbacks.
- Direct input by default on capable clients (tap to type); the host-owned write grant is invisible ([ADR 0036](adr/0036-terminal-input-authority-invisible.md)).
- `Ctrl+G`/slash command navigation and debug overlay.

Exit gate: an operator can complete the real-provider self-build mission without opening another UI.

## Milestone 4 — macOS command center

- Maintain the tracked React Native macOS shell and add the native SwiftTerm Fabric component.
- Garden, graph, terminal deck, artifact room, and synchronized selection.
- Keyboard control groups, lasso selection, split views, and multiple windows.
- Local direct runner connection and development relay fallback.

Exit gate: garden operations cover assignment, steering, pause, retry, approval, and direct terminal input (tap to type); raw terminal remains available.

## Milestone 5 — iOS supervision

- Device pairing and per-device permissions.
- Mission/attention snapshots, push notifications, approvals, steering, diff/check review.
- Reconnect through sequence/snapshot protocol.
- Direct terminal input from a paired device (tap to type); the write grant is acquired invisibly ([ADR 0036](adr/0036-terminal-input-authority-invisible.md)).

Exit gate: suspend the app during active work, then resume with no state loss or duplicated command.

## Milestone 6 — Discord presence and voice

The agent joins the team's server as a persistent member: one character, continuous memory, ambient supervision.

- Official Discord bot application; no user credentials.
- Slash commands, threads, visible memory controls.
- Attention-queue narration: the agent speaks or posts when mission state crosses an attention threshold (blocker, approval, budget, verification result).
- Channel authority tiers per doctrine: Discord roles bind to command tiers; steering and queries in-channel, approvals deep-link to an authenticated surface.
- Voice join/leave by explicit command, clear transcription indication, no raw-audio retention by default.
- Long-lived voice service separate from serverless request handlers.

Exit gate: consent, retention, deletion, and cross-channel visibility tests pass before voice memory ships; ambient-channel approval attempts are rejected in tests.

## Milestone 7 — garden progression

Only after operational reliability:

- verified outcomes grow biomes and unlock cosmetics;
- agent specialization derives from measured history;
- mission monuments and time-lapse replay;
- no reward for tokens, lines of code, number of agents, or apparent busyness;
- progression never grants security authority.

## Milestone 8 — team/enterprise control plane

- organization/workspace/repository/mission doctrine inheritance;
- RBAC, SSO, SCIM, audit exports, retention, data residency;
- runner fleet and private registries;
- policy simulation against historical missions;
- managed connectors and approval routing.
