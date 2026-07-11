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

- **Codex:** App Server JSON-RPC. Initialize once, start/resume a thread, start/steer a turn, normalize notifications, preserve thread/turn IDs.
- **Claude Agent SDK:** streamed `query()` session with bounded tools and project configuration. API/cloud-provider authentication only for third-party product use.
- **Pi:** strict LF-delimited JSONL RPC via `pi --mode rpc`; wait for `agent_settled`, preserve session stats, and support steering/abort.
- **Generic shell/local:** PTY escape hatch; semantic confidence is lower when state must be inferred.

Provider-native approval prompts do not replace product policy. The runner withholds privileged credentials and confines filesystem/network capability.

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

## Human takeover

- observers may read according to RBAC;
- one control lease by default;
- acquiring a lease pauses automated input;
- all input is attributed to user/device;
- lease expires or is explicitly released;
- agent resumes only after handback and optional summary;
- forced release requires higher authority and is audited.

## Herdr boundary

Herdr is an optional external pane host. Use its process/socket/session API through a `TerminalProvider`; do not scrape the rendered screen and do not make Herdr the persistence model. Keep native PTY and tmux adapters available.
