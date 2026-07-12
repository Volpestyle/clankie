# Worker and terminal runtime

## Worker identity

A worker run is canonical. It may have a native provider session, PTY, branch, worktree, terminal pane, artifacts, and subagents. A pane is only one view.

```text
Mission → Task → WorkerRun
                  ├── nativeSessionId
                  ├── worktree/branch
                  ├── terminalSessionId
                  ├── artifacts/evidence
                  └── child runs
```

## Provider adapters

- **Codex:** App Server JSON-RPC. A turn carries `workerRunId:attempt` as its client message identity, preserves thread/turn IDs, and converts authoritative completed command/file items into minimized semantic facts.
- **Claude Agent SDK:** streamed `query()` session with an explicit environment, enforced SDK sandbox, protected parent authentication, and role-bounded tools. Verification and review expose no Edit or Write tool.
- **Pi:** repository-pinned strict LF-delimited JSONL RPC. The runner owns persistent session/config directories, prepares the entire process behind `ShellSandbox`, and requires a native session ID for success.
- **Generic shell/local:** PTY escape hatch; semantic confidence is lower when state must be inferred.

Provider-native approval prompts do not replace product policy. The runner withholds privileged credentials and confines filesystem/network capability.

### Connector tools (MCP and web research)

Workers gain external tools only through the doctrine-projected MCP registry ([ADR 0027](adr/0027-mcp-worker-tool-projection.md), `doctrine/mcp-registry.example.yaml`). At fleet build the runner evaluates every registered tool as `mcp.<server>.<tool>` against the compiled profile and injects only exact `allow` grants: per-tool for Claude (`mcp__<server>__<tool>` allowlist plus a PreToolUse hook that denies ungranted non-filesystem tools), per-server for Codex strict config (a server with any withheld tool is dropped), and never for Pi, which stays offline. Registry servers may be scoped to task kinds; server processes receive only their declared static and credential-allowlist environment. With `CLANKIE_CLAUDE_WEB_RESEARCH_ENABLED=true` and a doctrine allow for the read-class `web.search`/`web.fetch` actions, the Claude worker additionally exposes native WebSearch/WebFetch on `research` tasks and advertises the `research` kind. The runner logs allowed and withheld projections at startup.

With `CLANKIE_BROWSER_ENABLED=true`, a compiled-doctrine allow for the read-class `web.browse` action, and a ready `agent-browser` binary and daemon, Codex shell workers additionally receive read-only browser control ([ADR 0028](adr/0028-worker-browser-control.md)). The runner starts the daemon outside the worker sandbox and gives the network-disabled worker only its namespaced local IPC endpoint. A daemon-enforced deny-by-default policy permits navigation and observation but denies clicks, form input, evaluation, upload/download, browser state mutation, and network interception. Form submission and publishing remain privileged connector actions rather than direct worker capabilities. Missing doctrine, a deny decision, an off flag, or failed binary/daemon readiness withholds the path and is logged at fleet startup.

### Readiness and advertisement

Provider configuration is opt-in. The runner advertises a descriptor only when executable/version, authentication, model, and enforced-isolation readiness all pass. Stable readiness issue codes explain unavailable providers without copying credential content or raw subprocess errors. The production default advertises no coding provider until at least one complete configuration passes.

The heterogeneous proof routes implementation to `codex-implementation`, verification/review to read-only `claude-verification`, and debugging to `pi-debugging`. These are distinct worker identities rather than aliases for one generic coding seat.

Pi uses a synthetic home and configuration with ambient extensions, skills, prompt templates, themes, context files, telemetry, and update checks disabled. Its model configuration names one pinned local model. The sandbox proxy permits only the exact configured localhost Ollama host and port; direct network access and silent unsandboxed fallback remain denied.

### Attempt evidence

Each settlement writes an atomic, validated runner evidence bundle below the artifact root. Its opaque reference and SHA-256 enter `WorkerResult.evidence`; a host path does not. The bundle contains:

```text
summary
files_changed[]
commands_run[]
checks[{command, exit_code, result}]
artifacts[{ref, sha256}]
remaining_risks[]
assumptions[]
nativeSessionId · provider · providerVersion · correlationId
```

Git state, trusted check exits, normalized completed events, runner configuration, and lease identity populate these fields. Provider prose, raw command text, streamed deltas, patches, output, and self-authored evidence do not.

## Worktree lifecycle

1. resolve immutable base commit;
2. create mission/task branch and worktree;
3. seed task contract and minimal context;
4. acquire path locks/write-scope lease;
5. start worker with bounded credentials and network profile;
6. collect events, terminal stream, diff, tests, and artifacts;
7. freeze result and release process lease;
8. verifier operates read-only or in a separate worktree;
9. integration task reconciles accepted branches;
10. clean up only after retention/approval policy permits.

The recurring control-plane heartbeat starts before candidate acquisition and initial evidence collection. Claim, event, heartbeat, and settlement calls retry with bounded backoff. An exhausted transient polling operation delays and continues instead of terminating the runner loop. A noninteractive run treats an unexpected `waiting_user` event as a blocked settlement and aborts the provider by default.

Worker processes run under durable leases (`ProcessLeaseManager` in `apps/runner/src/process-leases.ts`): liveness is pid + process start time (a recycled pid can never masquerade as a live worker), heartbeats extend the lease, an expired heartbeat transitions the run to a recoverable `expired` state in the event log, cancellation is cooperative-then-hard (SIGTERM, grace, SIGKILL) and idempotent, and on restart the runner re-adopts still-live processes or fails them explicitly. `MissionEngine.expireWorkerLease` requeues the task while attempts remain and fails it explicitly otherwise.

Steps 1, 2, 4, and 10 are implemented by `WorktreeManager` in `apps/runner/src/worktrees.ts`: write leases are exclusive-create records keyed by the canonical (symlink-resolved) path hash, orphaned leases are reclaimed on runner startup, and released worktrees are removed when unchanged or preserved with evidence when they hold uncommitted or unmerged work.

## Terminal protocol

Separate planes:

- semantic control events: prioritized, low volume;
- terminal snapshots/deltas/input/resize: high volume;
- artifacts: authenticated object retrieval.

Every terminal frame carries a monotonically increasing sequence. Reconnect asks from the last sequence; when unavailable, runner sends a terminal snapshot.

`TerminalManager` in `apps/runner/src/terminals.ts` implements this: output frames live in a bounded per-terminal replay buffer; evicted bytes fold into a rolling byte-tail snapshot, so snapshot + buffer is always a gap-free suffix of the stream. Reconnects inside the buffer resume exactly; older or missing sequences are resynced from the snapshot. Lagging observers are resynced from a fresh snapshot instead of buffering unbounded frames (backpressure). Input and resize require a live control lease; observation does not. Worker processes attach through a `TerminalTransport` — the built-in pipe transport merges stdout/stderr; a native PTY transport slots in behind the same interface.

Durable transports restore their previous terminal ID when a runner restarts.
The manager rejects duplicate IDs, so a recovered session cannot race a second
owner or silently fork a client's replay cursor.

## Status derivation

Agent status (`working`, `waiting_user`, `waiting_dependency`, `blocked`,
`failed`, `completed`, offline) is resolved through the tiered signal ladder in
ADR 0015: adapter protocol events first (turn lifecycle; a pending approval or
question is `waiting_user`), then runner leases and exit codes, then untrusted
heuristics (herdr `agent_status`, settle-then-classify with a local model),
which may only fill `unknown` or raise attention — never override a higher
tier. Status events carry `{tier, source, confidence, observedAt}` and ride the
control plane, never the terminal plane. "Done" is a projection concern
(completed + unacknowledged), not a detected state.

## Human takeover

- observers may read according to RBAC;
- one control lease by default;
- acquiring a lease pauses automated input;
- all input is attributed to user/device;
- lease expires or is explicitly released;
- agent resumes only after handback and optional summary;
- forced release requires higher authority and is audited.

## Captain worker control (operator parity)

The captain controls its workers through the same command surface a human
operator uses ([ADR 0018](adr/0018-captain-worker-control-parity.md)): worker-pane
slash commands (`/goal`, `/model`, `/effort`, steering text) for pane-hosted
harness workers, and the same vocabulary mapped onto protocol methods for
adapter-hosted workers. There is no captain-only control API. Arming a
harness's native `/goal` loop at delegation time is part of this surface.
Captain input is automated input under the takeover rules above — a human
control lease pauses it — and parity covers steering and configuration only;
approvals stay on authenticated surfaces.

The canonical [`clankie-lead` skill](../.agents/skills/clankie-lead/SKILL.md)
defines this captain path, and its [delegation protocol](../.agents/skills/clankie-lead/references/delegation-protocol.md)
specifies bounded briefs, goal arming, run receipts, harvest, resume, and cleanup.

## Herdr boundary

Herdr is an optional external pane host. Use its process/socket/session API through a `TerminalProvider`; do not scrape the rendered screen and do not make Herdr the persistence model. Keep native PTY and tmux adapters available.

When running under Herdr (`HERDR_ENV=1`), clankie panes self-report status over the socket (`pane.report_agent`) so Herdr displays them natively, and Herdr's `pane.agent_status_changed` events are ingested as a Tier-2 status signal (ADR 0015). Neither direction requires a Herdr fork.
