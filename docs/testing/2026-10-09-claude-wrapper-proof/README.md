# VUH-1922: Claude launcher proof

## Diagnosis

The running service was `e00005da57284499e3f53a4e14e30216a5fbf83a`, with
metric coverage beginning **2026-10-09 04:50:31.472Z**. At 05:58Z the
five-minute terminal refusal rate was **4.71%** (100/2,124). See the captured
[baseline metrics](baseline.json).

Joining private `fleet.local_proof.refusal_context` records to project-stage
diagnostics by `requestId` found **828 launcher mismatches among 913 terminal
refusals**, from 04:50:35 through 06:03:59Z ([counts](diagnosis.json)). The
remaining failures included unavailable launchers, native observations, membership
and one changed pane. They are not relabeled as benign.

Read-only Herdr and kernel observations of the dominant live pane showed:

```text
pane shell
└── Node: installed clankie claude --new  ← foreground process group leader
    └── installed Claude executable
        └── worker MCP bridge
```

Project proof mistook the Node group leader for Claude and rejected its
executable. This was a live launcher-path bug, not evidence of an exited pane
or stale socket. The old and revised observers read the same existing pane:
old → `launcher_mismatch`, revised → admitted Claude's kernel process identity
([sanitized results](live-observer.json)). Neither run restarted or changed the
pane. Original PID, lifetime, pane and path details remain in the owned worktree's
ignored `.local/vuh-1922/` evidence.

The large native counters have a different meaning: **5,599**
`process_unavailable/ESRCH/retry:true` and **1,166**
`socket_unavailable/EBADF/retry:true` observations came from the helper's global
process/FD scan. An unrelated process or FD can disappear between enumeration
and inspection. In **325** request IDs, a retryable fleet-scan diagnostic was
followed by project checks, demonstrating recovery before the project failure.
These diagnostics already do not increment terminal attempts/refusals. No
unconditional suppression was added: exhausted retries, hard native errors and
terminal failures remain visible and count.

## Change and checks

Only the exact installed Node + Clankie script with kernel argv[2] `claude` can
use the new native mode. The helper brackets shell, wrapper and Claude identities,
requires direct parentage and the shared foreground process group. Claude must
match the installed harness or its existing supported adjacent release. The
proof names Claude, preserving the subsequent socket-ancestry checks. Arbitrary
wrappers, non-children and changed observations continue to refuse.

Focused classification tests passed: **42 tests in 2 files**. They cover accepted
installed launchers, other scripts/executables, non-child and changing-wrapper
rejections, and native retry diagnostics versus terminal proof counters.
The native helper compiled with `-Wall -Wextra -Werror`; the real before/after
observer comparison passed. Root landing results are recorded on VUH-1922.

## Live acceptance

The owner deploys the checked commit. The required hour of normal live fleet
activity below 1% begins on that deployed runtime, not on this local observer
probe. That hour is **pending** at implementation landing; no restart, settings
change or synthetic traffic is authorized as a substitute.
