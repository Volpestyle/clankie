# VUH-1704: seven additional real OS diagnostic producers

Six explicit manual checks passed on macOS with the unchanged production helper,
real owned processes and sockets, and the production diagnostic schema and
collector. [Redacted observations](native.json) retain actual fixed events and
counts without PIDs, ports, paths or argv.

| Previously unmet reason  | Actual owned producer                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `executable_unavailable` | A real Node Unix listener fails the helper's Codex executable guard. This is a wrong-executable refusal, not an OS permission denial. |
| `fd_list_bounds`         | A real TCP client opens more than 16,384 FDs after raising only its own soft limit within the unchanged hard limit.                   |
| `executable_changed`     | One PID repeatedly executes two distinct on-disk binaries while fresh kernel proofs read its executable.                              |
| `argv_changed`           | A running owned program changes its own argument storage between actual kernel reads.                                                 |
| `process_changed`        | The owned parent exits while its live child's PPID is being proved.                                                                   |
| `ancestry_unavailable`   | A root exits during a real TCP owner's ancestor observations; only the leaf owns the client FD.                                       |
| `ancestry_changed`       | The same root-exit workload changes the middle ancestor's PPID during the proof.                                                      |

Each target event came from the real native helper and its refusal was counted.
Successful independent observations are not admission or mutation requests.
The direct helper cases do not claim the full HTTP-to-Herdr admission boundary
for every reason. No proof input, kernel call or provider success is substituted.
Each workload is bounded and contained within its heavy permit; the production
helper still has its own budget. These manual cases add no workload to push CI.

The first bounded reparent probe observed no target diagnostic; repeated fresh
observations during the real exit produced `process_changed`. An initial
ancestry sandbox denial did not block the kernel API and therefore did not
prove `ancestry_unavailable`. The later actual root-exit workload establishes
it. Earlier exec probes produced only already-covered argument failures; actual
executable transitions and argument-storage changes establish the new reasons.
Failed probes remain under ignored `.local/1704/`; they were not rewritten as
successful captures.

The prior [four-producer and held-alert evidence](https://github.com/Volpestyle/clankie/blob/e8a7b71e/docs/testing/2026-10-06-proof-alert-defensive-os/README.md)
remains separate. Together these establish eleven of the sixteen formerly
unmet defensive OS reasons. Five still have no real producer:
`clock_unavailable`, `allocation_failed`, `fd_record_invalid`,
`socket_identity_invalid`, and `ancestry_cycle`. Their vocabulary/schema checks
are not OS producer evidence. Healthy kernel observations do not supply negative
FD records or cyclic parentage; no incompatible kernel ABI, allocator injection
or host exhaustion was introduced to manufacture those events.

Owner-TUI threshold delivery and the next Linear check-in remain open with
Ash's VUH-1743 installed route repair and the lead. Protocol ACKs and submitted
booleans do not establish acceptance in James's original TUI. No original lane
was closed, restarted or repointed. Keep VUH-1704 open.

Reproduction uses both fleet wrappers, the built production helper and manual
opt-in:

```sh
~/.herdr-handoffs/clankie-backlog-20261003/bin/heavy clankie heavy --seat Lux -- node scripts/build-fleet-proof.mjs
~/.herdr-handoffs/clankie-backlog-20261003/bin/heavy clankie heavy --seat Lux -- env FLEET_ADDITIONAL_OS_TEST=1 pnpm exec vitest run apps/clankie/test/fleet-additional-os-native.integration.test.ts
```

Service typecheck and scoped lint pass. Raw results are
`.local/1704/additional-seven.log` and the per-case `evidence.json` files.
