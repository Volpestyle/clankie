# VUH-1976 — governed dev server lane

Tracks: https://linear.app/vuhlp/issue/VUH-1976

The server lane holds no full/light slots. It has up to two slots sharing 20%
of machine cores, with sampled native CPU throttling of owned group members.
Custom services select it with `clankie heavy --server -- COMMAND`; recognized
dev/watch commands select it automatically. Holder alerts identify servers and
full/light jobs held over 15 minutes, without terminating a job for its age.

## Proof

- Real server listeners occupied every server slot while a bounded build
  completed and another server waited in its independent queue.
- An old live bounded lease produced an age alert and continued serving HTTP.
- A registered native runner limited three CPU-burning children to **0.425
  cores** under a **0.5-core** budget over **6.219 seconds** in the final focused run.
  The fractional budget exercises throttling on every test host; production
  chooses its budget from the machine's available cores. This is sampled
  governance, not a hard instantaneous kernel quota.
- Lane-aware arbiter admission checks load and memory; new server waiters
  remain usable beside an older arbiter that advertises no server support.
- Nested servers started real listeners with every server slot occupied by
  their verified parent wrappers. Under a bounded parent, a nested server
  instead acquired its own CPU-governed server permit. Exit status was preserved.
- A real Darwin launcher with an exited, unreaped child resumed, reaped it and
  exited 17. Before the fix, it stayed stopped until cancellation (exit 143).
  Unknown CPU observations now allow brief proven-member resume windows charged
  at the machine's maximum CPU rate. CPU sample updates are atomic, so a failed
  later member read cannot repeatedly charge an earlier member's old baseline.

The subprocess proof uses real native locks, journals, process births, signals,
listeners and CPU accounting. Lane admission pressure is controlled to isolate
it from unrelated fleet work. API/CLI proof uses a real headless CLI, real HTTP
routes, local credentials and a local notification receiver; it does not send
notifications into the owner's live fleet.

## Checks and limits

Source revision: `f9e39bf17` on `clankie2/vuh-1976-server-lane`.
Focused server/API proof: **8 passed**, 11 unrelated CLI cases skipped by the
name filter. The exact independent full/simulator/server capacity case also
passed in isolation. The proof uses real `pnpm dev`, listeners, native runners,
CPU accounting, HTTP status, doctor output and notification retry/deduplication.

The raw record retains the initial API/CLI invocation error, the initial root
gate failure on an exact capacity assertion missing the new fields, the nested
server failure, and the Darwin shutdown failures. Those were corrected; they
are not timing waivers. The capacity assertion now pins every documented field.
One subsequent local root gate was interrupted before source fixes, and one
queued gate was stopped before admission; neither is reported as passed.
Clankie's Oct 10 instruction makes the integrator's exact-tree gate authoritative
and skips another local root gate. Its durable receipt and landed commit are
reported on the issue before closure.

CPU is sampled every 100 ms. Brief bursts can exceed the budget; rapidly reaped
children can be charged conservatively twice. Detached and privileged processes
are outside the owned same-user process-group contract. No live Expo workload,
official release or simulator was run for this change.
