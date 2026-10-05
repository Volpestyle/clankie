# Manual restored-bridge frequency benchmark

Run only when explicitly requested, with other native probes paused. This creates
an isolated Herdr daemon and twenty ordinary fixture parents/foreground processes;
it never touches the live fleet, starts a model, or uses a provider account.

The benchmark creates ten genuine foreground process observations and UUID
metadata reports in its own panes. Ten private ordinary Node parents outside those
panes spawn the shipped `fleet-mcp.mjs` stdio client. Actual `LocalCodexSeats`
registrations capture their lifetimes, bind their UUIDs, write durable records,
and are then reconstructed before any bridge starts. Restored registry checks use
the real project process observer. The test launcher seam trusts only the exact
foreground fixture executable and script. This models the native private-server
registry topology, not an installed Codex TUI or its full app-server behavior.

The clients receive actual MCP initialize/initialized/tools-list messages and keep
stdio open. They run their shipped catalog and channel poll intervals; no synthetic
HTTP loop substitutes for them. The body uses the real LocalFleetLink, local proof,
WorkerMcp, FileCredentialStore, SettingsStore and empty createMcpHost catalog.
There are no connected providers. An empty in-memory mailbox implements the same
extra local route validation and long-poll wait as the production seat route.
No message or tool effect is requested.

Each variant measures at least sixty seconds after bounded initial discovery.
Unready bridges and refused requests remain in evidence. No test-level HTTP retry
conceals them; the actual shipped bridge's normal poll/retry behavior remains.

```sh
PROJECT_PROOF_FREQUENCY_TEST=1 PROJECT_PROOF_FREQUENCY_VARIANT=current \
  pnpm exec vitest run --config vitest.config.ts \
  apps/clankie/test/project-proof-frequency.integration.test.ts
```

`ae91cca8` and `b5b24bdb` are optional preserved baseline variants. Before running,
preserve their four files `local-fleet-proof.ts`, `local-fleet-process.ts`,
`project-process-proof.ts`, `local-codex-seats.ts` from `apps/clankie/src`, plus
`integrations/fleet-proof/native-process-proof.c`, below
`.local/project-proof/frequency/baseline-<ref>/`. Preserve the worker's `bin/`
and `.claude-plugin/plugin.json` tree as `worker/` in that directory. Use `git show`
on that exact ref, never live credentials or another running installation. Keep
SHA256 provenance next to these ignored inputs. The baseline loader bundles these
unchanged modules from the original dependency resolution directory.

Actual Node ChildProcess dispatches are recorded with successful spawn events,
PIDs and close timestamps. CPU sampling is outside the measured dispatch window:
`process.cpuUsage` measures body CPU and the SDK `proc_pid_rusage` endpoint sampler
measures live helper, Herdr and bridge CPU. The body's `ri_child_*` counters measure
aggregate reaped child CPU; for fork-heavy baselines this combines native helper
and Herdr CLI costs and must not be mislabelled helper-only CPU. Persistent helper
CPU is separately sampled while it is alive. No per-request CPU sampler or wait4
wrapper changes the proof path.

Evidence under `.local/project-proof/frequency/` includes all requests and reasons,
proof/registry counts, initial and final liveness, CPU endpoints and all spawn
records. This owned workload cannot establish the live body's post-deployment CPU.
