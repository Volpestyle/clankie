# VUH-1743: receiver pump follow-up

This follow-up is not live Claude acceptance. The original `global-default`
Claude session and `w3Z:p2N` have been preserved during read-only diagnosis.

## What the original loaded source proves

The healthy update receipt
`~/.clankie/updates/70adecaa-cd71-4dc1-bfb9-a31bbbdc5cee/result.json`
installed `e1f457507f9dd9e8b32e7468d9384ba9d3d390dc` at
2026-10-06 02:12:11.402Z. Original bridge PID 51139 started at 02:12:57Z,
parent Claude PID 99898 at 02:12:53Z. The next update receipt
`3df9e088-ad48-41cd-9500-40d25a0e7660` retains the previous
`apps/tui/src/command/mcp.ts`, byte-for-byte equal to that revision
(SHA-256 `846ec394f18f57e82eb3672adaa5e45884d3acb6539bfa96169c815353261995`).

That loaded pump awaits a channel notification, then throws when the exact ACK
returns false; an ACK exception also escapes. Its outer `.catch(() => undefined)`
silently swallows the rejection and ends the pump while tools keep serving.
Only poll failures reach the old stderr diagnostic; fatal ACK or notification
failures leave no stopping-error record. Updating files afterward cannot
replace code already imported by this Node process.

The last observed original channel event was
`seat-3bd89cc3-928c-4080-a4e3-01c37b9943a3` at 03:40:44.006Z. Its retained
delivered receipt has fingerprint
`315a7b42f3bf4f6e134d9b17f90de468327a2792ffe2660e12e832d9dce5ecc1`.
The precise error or lost ACK response that stopped the original pump remains
unproved: the old wrapper did not log fatal rejections, and its original stderr
was piped into Claude with no matching persisted log found. A delivered ledger entry cannot establish that the bridge
received a successful HTTP response.

## Repair and boundaries

The current source already retries failed ACKs, but does so indefinitely before
polling again. A sustained ACK-only outage therefore unbinds an otherwise live
seat. This follow-up retries each exact receipt once, in parallel across the
page, then resumes polling. The mailbox's existing matching-recipient poll
reconciles previous successfully notified takes. Unsettled IDs remain available
for exact late acknowledgment after a service restart. No notification is
replayed, and diagnostics cannot throw the pump out of its delivery loop.

A rejected channel write stays fenced and stops polling: polling would otherwise
implicitly acknowledge a possibly unseen event. A content-free local journal
retains process ID, conversation, source hash, exact event ID, stage and error
class/code to make subsequent pump failures diagnosable.

## Verification

The owned regression uses production authenticated seat routes, a real local
HTTP server, the production mailbox and disk delivery ledger, the installed MCP
SDK, and the actual stdio bridge in an owned subprocess. It injects HTTP 503,
TCP response loss after durable ACK, and HTTP 404 at the network boundary. It
checks continued polling, a subsequent wake, one channel event per original,
retained receipts, same process ID, a usable tool bank and the diagnostic journal.
The SDK transport peer is not a Claude operator and does not prove model review.

The regression fails on unchanged `2acffdcf`: its ACK retry makes no subsequent
polling progress. The repaired source passes all 42 checks in the new integration
file, existing MCP bridge checks and existing mailbox checks. Both affected
package typechecks and scoped lint pass. All commands used the fleet resource
wrappers; dependencies were installed with a real frozen-lockfile pnpm install.

The owned mailbox uses a one-second grace, below production's 45 seconds. An
initial 200 ms fixture window expired during actual HTTP error scheduling: the
diagnostic trace measured one retry around 340 ms while polling did resume. The
window was adjusted from that observation; the source's bounded ACK retry and
uncertain-delivery rules were preserved.

Raw local evidence is in `.local/evidence/vuh-1743-pump/`: `loaded-source.json`,
`red-base.txt`, `failure-timing-2.txt`, `green-tests.txt`, `typecheck.txt` and
`lint.txt` in this worktree.

## Remaining live acceptance and lead decision

Pell must land the initial `2d23a90e` repair and this checked follow-up, report
the healthy installed revision and canonical update receipt, then coordinate
an authorized same-session MCP reconnect. A normal tool registration has not
been proved to revive the old pump. Preserve `global-default`, the original
Claude session `5bcd52ff-8d50-4139-962a-46b323c7a990`, pane and delivery fences.
After the receiver is live, the lead requests a fresh James comment; join its
accepted signed hook, external activity, native delivery receipt and exact
`w3Z:p2N` transcript event within about a minute.

James settled the routing/read acceptance on 2026-10-06 in VUH-1743:
verified project activity goes to its configured lead chat, otherwise
`global-default` with the project named. A target-chat consumption receipt,
not a transport ACK, permits matched notifications to be marked read.
The separate [routing/read follow-up](../2026-10-06-linear-routing-read/README.md)
implements those decisions and retains exact uncertain mutation claims.
No live provider notification or project destination has been changed by Ash.
