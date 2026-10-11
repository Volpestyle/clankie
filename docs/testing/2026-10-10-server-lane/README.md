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
- A registered native runner limited three CPU-burning children to **0.417
  cores** under a **0.5-core** budget over **6.055 seconds** in the first run.
  The fractional budget exercises throttling on every test host; production
  chooses its budget from the machine's available cores. This is sampled
  governance, not a hard instantaneous kernel quota.
- Lane-aware arbiter admission checks load and memory; new server waiters
  remain usable beside an older arbiter that advertises no server support.

The subprocess proof uses real native locks, journals, process births, signals,
listeners and CPU accounting. Lane admission pressure is controlled to isolate
it from unrelated fleet work. API/CLI proof uses a real headless CLI, real HTTP
routes, local credentials and a local notification receiver; it does not send
notifications into the owner's live fleet.

## Checks and limits

Initial focused server/light suites: 7 passed. The initial API/CLI proof failed
on an incorrect test call to `doctorCommand`; that invocation was corrected.
Final checked revision, results and landing evidence are recorded below before
completion.

CPU is sampled every 100 ms. Brief bursts can exceed the budget; rapidly reaped
children can be charged conservatively twice. Detached and privileged processes
are outside the owned same-user process-group contract. No live Expo workload,
official release or simulator was run for this change.
