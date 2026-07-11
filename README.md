# Sapling Agent OS

A local-first operating system for a **lead agent** that plans missions, dispatches heterogeneous coding agents, supervises their work in visible terminals, enforces an orchestration doctrine, gathers evidence, requests approvals, evaluates outcomes, and improves the system through governed self-build loops.

> Status: executable research scaffold. The deterministic self-build laboratory runs without model credentials; real Codex, Claude Agent SDK, Pi RPC, Herdr, Discord, iOS, and macOS integrations are intentionally isolated behind adapters and are not production-hardened yet.

## Product thesis

The product is not “one more chat assistant.” Its primary object is a **Mission** and its primary job is fleet leadership:

1. Turn an outcome into an explicit dependency graph.
2. Route tasks to the best available harness.
3. Isolate writers and preserve native agent sessions.
4. Detect failure through independent verification.
5. Repair or replace failed work without weakening tests.
6. Keep privileged actions behind deterministic policy and human authority.
7. Emit enough evidence to evaluate whether the lead improved the result.

The operating rule is:

> The lead owns intent. Deterministic code owns scheduling and policy. Workers own bounded execution. Humans retain authority.

## Prove the hypothesis locally

Requirements: Node 24+, pnpm 11+, and Git.

```bash
corepack enable
pnpm install
pnpm doctor
pnpm eval:self-build
```

The credential-free self-build lab:

- creates a mission and typed task graph;
- delegates context, implementation, verification, and debugging to distinct simulated harnesses;
- injects an off-by-one implementation defect;
- requires an independent verifier to detect it;
- dynamically assigns a debugger to repair it;
- reruns unchanged acceptance tests;
- evaluates a privileged merge request through doctrine;
- records a human approval before simulated execution;
- produces a scorecard, event log, mission snapshot, and garden projection.

Outputs are written to `artifacts/evals/self-build/`:

```text
self-build-report.md
self-build-report.json
self-build-events.jsonl
self-build-audit.jsonl
self-build-audit-verification.json
self-build-snapshot.json
self-build-garden.json
```

A passing result proves the **control-loop mechanics**, not general intelligence. The real-provider experiment described in [`docs/02-lead-agent-e2e-proof.md`](docs/02-lead-agent-e2e-proof.md) is the next evidentiary gate.

## Main applications

| App                         | Responsibility                                                                   |
| --------------------------- | -------------------------------------------------------------------------------- |
| `apps/captain-eve`          | Eve-based captain personality, conversation, planning, critique, and synthesis   |
| `apps/control-plane`        | Mission API, doctrine compilation, scheduling state, policy decisions, approvals |
| `apps/runner`               | Local worktrees, processes, PTYs, credentials, provider sessions, control leases |
| `apps/tui`                  | Operator console built specifically with `@earendil-works/pi-tui`                |
| `apps/apple-command-center` | Shared React Native iOS/macOS garden, graph, artifact, and terminal client       |
| `apps/discord-bridge`       | Official Discord bot/channel bridge and explicit voice join/leave boundary       |
| `apps/relay`                | Development remote relay with separate semantic-control and terminal-data planes |
| `apps/lead-agent-lab`       | Deterministic self-build and lead-agent evaluation laboratory                    |

## Core packages

```text
protocol             stable commands, events, plans, evidence, approvals
mission-engine       deterministic DAG lifecycle and worker leasing
doctrine             profile resolution, routing, constraints, action policy
evals                lead-agent scorecards and release thresholds
worker-sdk            provider-neutral worker contract and routing
worker-codex         Codex App Server adapter
worker-claude        Claude Agent SDK adapter
worker-pi            Pi JSONL RPC adapter
worker-sim           deterministic test harness workers
jsonl-rpc            strict subprocess protocol transport
event-store          append-only hash-chained audit/replay store (durable SQLite + JSONL backends)
credential-broker    short-lived capability grants; no provider secrets in workers
terminal-protocol    snapshots, deltas, sequence replay, and control leases
garden-model         operational events → stable spatial presentation state
observability        redacted Pino logs, trace helpers, diagnostics
analytics            consent-gated, content-minimized product analytics
api-client           typed control-plane client
```

## Three synchronized operator views

- **Garden:** fleet-level assignment, attention, approvals, and spatial status.
- **Graph:** task dependencies, delegation, artifacts, conflicts, and communication.
- **Terminal deck:** raw process observation and explicit human takeover.

All three are projections of the same mission event stream. A terminal pane is attached to a worker run; it is not the worker’s identity or the source of truth.

## Repository laws

1. Every writer receives an isolated worktree or sandbox and an explicit write scope.
2. A model cannot grant itself permission, waive a test, merge, deploy, or modify doctrine.
3. Verification is independently attributable and runs acceptance tests that the implementer did not silently weaken.
4. Provider output is untrusted input; structured semantic events and deterministic state remain authoritative.
5. Secrets stay in the runner or credential broker. Workers receive capabilities, never organization-wide credentials.
6. Every mission, task, approval, and external action carries a correlation ID and doctrine hash.
7. Self-improvement is proposal-driven and regression-gated; there is no uncontrolled runtime self-modification.

## Development commands

```bash
pnpm doctor              # toolchain and optional integration checks
pnpm arch:check          # dependency and privilege-boundary invariants
pnpm typecheck
pnpm test
pnpm eval:self-build
pnpm check               # format, lint, typecheck, tests, architecture, eval
pnpm support:bundle      # redacted diagnostic archive
pnpm --filter @sapling/tui dev
pnpm --filter @sapling/control-plane dev
```

Read [`AGENTS.md`](AGENTS.md) before assigning work to any autonomous coding agent.

## Documentation map

- [`docs/00-product-thesis.md`](docs/00-product-thesis.md)
- [`docs/01-architecture.md`](docs/01-architecture.md)
- [`docs/02-lead-agent-e2e-proof.md`](docs/02-lead-agent-e2e-proof.md)
- [`docs/03-build-plan.md`](docs/03-build-plan.md)
- [`docs/04-doctrine.md`](docs/04-doctrine.md)
- [`docs/05-worker-and-terminal-runtime.md`](docs/05-worker-and-terminal-runtime.md)
- [`docs/06-garden-and-graph.md`](docs/06-garden-and-graph.md)
- [`docs/07-evaluations.md`](docs/07-evaluations.md)
- [`docs/08-observability-debugging.md`](docs/08-observability-debugging.md)
- [`docs/09-analytics-privacy.md`](docs/09-analytics-privacy.md)
- [`docs/10-security-threat-model.md`](docs/10-security-threat-model.md)
- [`docs/11-development.md`](docs/11-development.md)
- [`docs/12-release-criteria.md`](docs/12-release-criteria.md)

## Open-core boundary

The protocol, local runner, TUI, doctrine language, adapters, evaluator, and local event store are intended to remain inspectable and extensible. Hosted relay, team collaboration, managed connectors, fleet policy, private registries, long-term analytics, compliance, and enterprise administration are the natural commercial layer. See [`docs/00-product-thesis.md`](docs/00-product-thesis.md).

## License

The scaffold is Apache-2.0. Third-party dependencies retain their own licenses; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Herdr is treated as an external optional integration and is not vendored.
