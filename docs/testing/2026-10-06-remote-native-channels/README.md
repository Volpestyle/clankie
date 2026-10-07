# Remote native channels and authenticated receipt recovery (VUH-1527)

Current live result on runtime `c72c3d02`: the first new-intent PC hire stopped
with an uncertain SSH outcome before recording a worker allocation. Original
`3989da1d` remains fenced; its exact authenticated host journal is `launching`,
and deployed recovery refuses the missing allocation. Report, peer exchange,
catalog and the complete fresh acceptance remain unproven. VUH-1527 stays open;
see the [current evidence and approved recovery](live/c72c3d02/README.md).

The [explicit unknown-abandonment repair](unknown-abandonment/CHECKS.md) now
records the approved separate disposition without assigning a pane or claiming
no launch. Native security review and focused real-host/CLI tests passed;
deployment and the original PC settlement remain pending.

The earlier `7ee4da04` run proved hire, brief, follow-up, exact completion wake,
tracker isolation and explicit SSH-loss refusal, with sender/peer/catalog gaps.
A subsequent owned hand-started `--no-daemon` Queue recheck passed and was cleaned
up; [bounded native proof](live/c72c3d02/hand-queue-earlier-run.json) retains that
distinct result without rewriting the [earlier failures](live/7ee4da04/README.md).

A [fresh-root naming and catalog repair](sender-naming/CHECKS.md) now prevents native automatic title helpers from revoking managed remote sender authority without granting those helpers an exception. Both fixes passed native security review; deployed PC acceptance remains pending.

The deployed [sender and completion repair](sender-completion/CHECKS.md) adds
original-registration retention after unavailable native inventory reads,
original-backend proof, shared fleet-qualified persona identity, and exact
Codex follow-up harvests. Source checks and native security review passed; the
remaining live failures above still require repair before closure.

The [pane-address repair](pane-address/CHECKS.md) now accepts the same-fleet bare
or qualified address, keeps kernel/private-seat queries host-local, and resolves
native membership against the original qualified hire allocation. Its
[native security review](pane-address/SECURITY-REVIEW.md) is approved. Source
verification passed. The deployed owned-pane acceptance below proves the repair
and records the remaining native sender and conversation gaps.

Audit base: `origin/main` `8fcf47a5`, 2026-10-06. Linear issue and its five newest
comments were read, including the 2026-10-05 PC live acceptance and added peer
exchange criterion. The initial `13b1e445` audit corrected marketplace Swarm
descriptions. Clankie then authorized the guarded recovery below.

## Implemented recovery

`clankie hire-receipt settle ORIGINAL_NATIVE_HIRE_UUID` calls the operator-only
API with that original identity. The service authors all evidence through its
configured SSH transport. Before any remote hire effect, it records a host
reservation and pins the exact host/session/key/fingerprint. The service persists
an irreversible launch guard before the host's exclusive launch transition.
Preparation, pane allocation, resume and send are all behind that barrier.

A still-reserved host journal can seal after a fresh Herdr pane/agent and OS
process census. Launch and seal share an exclusive lock, so a late original
cannot launch after sealing. The local receipt retains `settlement` evidence,
reported as `settled-not-launched`, permanently. Its original key cannot dispatch
again. Missing history, allocated identity, launch commitment, changed connection,
incomplete census or revoked authority refuses. No caller can submit its own proof.

The host program is installed once per version on each host, under
`~/.clankie/hire-receipt-programs/<sha256>.js`, in bounded chunks that join only
when the bytes match the digest. Each operation sends a small loader, the digest
and the service-authored request; the loader evaluates exactly the bytes it
hashed. A missing or different program refuses before it runs, with a marker
unique to that dispatch, and only that refusal lets the service install and send
the same request again. Inlining the program on every call outgrew the Windows
command line ([VUH-1780](command-bound/CHECKS.md)).

[Native security review](settlement/SECURITY-REVIEW.md) approved the final design.
[Actual PC census](settlement/pc-census.json) at 2026-10-06T03:22Z proves the new
guarded host path through `volpe@supedupsilly`: 5 panes, 534 processes, 4 sessions;
same evidence on repeat inspection; late launch refused. This was a fresh census
test reservation with no hire, pane or harness requested. Its host journal remains
retained. It does not establish the old receipts' history or the hire acceptance.

## Source disposition

- Remote Codex hires have a dedicated loopback app-server, an owned SSH forward,
  original-thread delivery, tracker isolation and native completion handling:
  `apps/clankie/src/captain/remote-codex-app-server.ts`.
- Remote Claude uses the same native channel/Stop hooks as local workers:
  `apps/clankie/src/captain/remote-claude-worker.ts`. Isolation includes default,
  configured and ancestor connector sources, with ambiguous inputs refused.
- `apps/clankie/src/captain/herdr-watch.ts` retains native delivery fences.
  Claude Stop observations do not assert a per-message completion correlation.
  Lost or uncertain delivery never permits terminal typing or another launch.
- Independent linked workers reach Clankie through the worker bridge; fleet peer
  messages use verified bindings. Those paths need live acceptance, not rebuilding.

## Current PC observation

`clankie doctor --machine pc` and `clankie connections` reached the PC on
2026-10-06. Fleet `pc` was healthy and link state `ready`. The default Herdr server
was 0.9.3; the separate `kh2`/`kh2-desktop` sessions were not running. This is
transport/install evidence, not native delivery or completion evidence.

The worker bridge's initial `message_clankie` report returned `uncertain` with
original delivery ID `b7d832bc-6c6e-4cf6-8615-f9048869623c`. Subsequent calls only
reconciled that ID and returned the same unresolved outcome. No alternate route
or replacement was used. Peer tools later disappeared from this worker's catalog,
even while CLI fleet status reported peer messages enabled. A handoff to Pell
requires fresh proven seat discovery; `pell-f996` was not returned in the earlier
same-fleet inventory, which exposed native `term_*` recipient IDs.

## Legacy boundary

The original Codex hire `9a42ada0-5111-497e-b43c-25881932778c` allocated a shell
before preflight failed. Claude native hire `e70fd47b-264a-42c3-aac9-7f25b6636a4f`
allocated a pane and inserted its brief before expired login stopped work. Neither
legacy record has a historical host reservation. The [exact-byte no-launch
refusal](settlement/legacy-refusal.json) correctly refuses both; current absence
cannot prove they never launched. The positive-delivery and abandonment paths
below address those distinct dispositions without reclassifying them as no-launch.

## Focused verification

The worktree has a real independent frozen-lockfile installation, with no shared
dependency/cache symlinks. The final delta passed 98 focused tests in seven service
suites, including a real isolated Herdr server, OS census, host journal transitions,
PC-grounded native channel goldens, corrupt/conflicting mailbox journals, forged
metadata, duplicate attributes/events, invalid session IDs, sidechains, redirected
files, truncated histories, irreversible recovery and original-key retention.
Three CLI cases passed over real HTTP for no-launch, delivered and abandoned
requests, checking exact identity/disposition and refusal without redispatch.
Clankie/TUI typechecks, scoped lint, formatting, diff and documentation links passed.
No full `pnpm check`, eval, account login or production settlement ran.

## Follow-up recovery candidate

`clankie hire-receipt settle seat-71022bcd-8afe-44cd-9d83-bd71d1ceab42 delivered`
now has a supported operator-only path. It resolves the exact retained original
mailbox identity, authenticates a fresh host census, reads the original workspace's
native Claude history and attaches unique native channel-origin evidence. Historical
insertion is delivery; the login error does not establish completed work.

`clankie hire-receipt settle NATIVE_HIRE_UUID abandoned` records explicit operator
abandonment of an allocation, retaining prior uncertainty and current census proof.
Both commands retain all originals/evidence and block dispatch/adoption of those
intents. Recovery never closes panes, registers controllers or creates watches.
Normal exact-session recovery is fenced while operator recovery is in progress.

[Native security approval](settlement/SECURITY-REVIEW.md) covers the final delta.
[Authenticated PC program proof](settlement/pc-recovery-proof.json) recovered the
exact real event and recorded abandonment under an isolated test receipt. The host
had five panes, four native sessions and a complete process census. Both old
`pc/wA:p2` and `pc/wA:p3` are absent; no old pane was closed or adopted. Production
native receipts and the existing delivered ACK remain unchanged.

The [real operator API probe](settlement/production-api-refusal.json) returned
HTTP 400 for the new recovery request. Deploy this branch before settling the
production originals; do not write the journals behind the running service.
Then record delivered for the original channel event and abandoned for native
hires `9a42ada0-5111-497e-b43c-25881932778c` and
`e70fd47b-264a-42c3-aac9-7f25b6636a4f` through the supported CLI.

Fresh PC hire → brief → follow-up → peer acceptance remains unrun because the
requested original settlements need that deployed API. Claude's read-only auth
status reports `loggedIn:false`. James's exact login ask: on supedupsilly open a
new Claude terminal, run `claude`, then `/login` and complete personal sign-in;
tell Clankie when done. Use Codex for acceptance while Claude is signed out.
No accounts/configuration, existing panes or desktop controls changed.

VUH-1709 normal PC update still needs confirmation that Pell landed and deployed
`9ab0e1af`. VUH-1563's three-step James check is already on its ticket. The Linear issue read returned fleet-tool HTTP 403 during this run, but the
handoff comment at 03:58Z succeeded as Clankie ([comment](https://linear.app/vuhlp/issue/VUH-1527#comment-beeb7fd9-85c8-438d-b9e8-fb746a4114ea)). No other
Linear write returned 403 this turn, and no connector substitution was used. `message_clankie` remains fenced by its original uncertain
receipt; reports are visible in Tess's pane for Clankie to relay.

## Deployed recovery and fresh PC acceptance, 2026-10-06 05:35Z

Runtime `f6260751` contains the reviewed recovery. The supported operator CLI
successfully settled all three originals, in this order, without resend:

- [Original brief](live/original-delivered.json)
  `seat-71022bcd-8afe-44cd-9d83-bd71d1ceab42`: `settled-delivered`, with the exact
  authenticated native Claude event, session, entry ID and transcript hash.
- [Legacy Codex hire](live/original-codex-abandoned.json)
  `9a42ada0-5111-497e-b43c-25881932778c`: `abandoned`, with fresh host census.
- [Legacy Claude hire](live/original-claude-abandoned.json)
  `e70fd47b-264a-42c3-aac9-7f25b6636a4f`: `abandoned`, with fresh host census.

All journals and evidence remain retained. Both legacy allocations were absent;
no legacy pane was closed, adopted or relaunched. Positive insertion evidence
does not establish that the expired Claude account completed its old brief.

After the approved normal PC update to worker 0.6.6, a new owner conversation
`conv-b7ff6ebf-5264-4c94-8c74-5530d5a4cb45` dispatched exactly one Codex hire
into the granted KH2 directory. The [result](live/a-hire-result.json) is
`start_unconfirmed`: the remote launcher rejected `CLANKIE_EXPECTED_TOOL_NAMES`
in the controller's launch environment before creating the native server. No
brief, follow-up or peer message was delivered, and no fallback started.
The [new original receipt](live/a-original-receipt.json)
`719dd6b1-2814-4c2b-9eb6-118fb785427c` remains unresolved and retained. Do not
retry this hire or remove its claim. The two owned shell panes were empty with
no drafts before [cleanup](live/cleanup.json); the hook-test pane was also closed.
The final PC roster matches the original five panes.

The follow-up candidate consumes that controller metadata only if the identical
value is already present in the scoped bridge configuration. All other remote
environment/account overrides still fail before SSH. [Native security review](live/SECURITY-REVIEW.md)
approved the change. [46 focused tests](live/focused-tests.txt), Clankie typecheck,
scoped lint, formatting and diff checks passed. At this checkpoint the candidate was not deployed;
native PC delivery, follow-up, completion wake, tracker isolation and peer-message
acceptance remain open. The failed test's original receipt also needs an explicit
supported disposition before a later acceptance attempt.

VUH-1709's normal update succeeded, but native worker hooks require owner trust
review before execution proof. Claude remains signed out; Clankie is passing the
existing `/login` ask to James. No accounts, manual config edits, other panes or
desktop operations changed. `message_clankie` still reconciles the old unresolved
receipt; the worker has no callable MCP refresh capability, so its original
controller needs to refresh that connection on the same thread. Linear reads and
tool discovery now succeed through Clankie's OAuth app.

## Deployed 72c1571a recovery and fresh hire refusal

Clankie confirmed runtime `72c1571a3a9a13db6af1189594febaf4cd2d5e50`, including
`9d280b68` and the native trust/connection fix. The installed checkout matched
that SHA. On 2026-10-06 at 06:12Z, the supported operator CLI settled
`719dd6b1-2814-4c2b-9eb6-118fb785427c` as **abandoned**:

```sh
clankie hire-receipt settle 719dd6b1-2814-4c2b-9eb6-118fb785427c abandoned
```

The receipt had committed launch and allocated a shell, so historical no-launch
was not a valid disposition. The service's authenticated census observed five
panes, 548 processes and four sessions on the pinned PC host. Its original
allocation `pc/wB:p2` was absent. The retained evidence records its original key,
fingerprint, host identity and census hash. No original was resent, adopted,
deleted or relaunched. [Settlement result](live/72c1571a/original-failed-hire-abandoned.json).

The explicit fresh acceptance used a new owner conversation, a different bounded
brief, a named Codex tester and the same granted PC working directory. The public
`spawn_seat` API refused it before pane or native server allocation:

> Original hire 719dd6b1-2814-4c2b-9eb6-118fb785427c is settled. Its receipt is retained; this original intent cannot dispatch again.

[Fresh request](live/72c1571a/fresh-hire-intent.json) and
[public result](live/72c1571a/fresh-hire-result.json) establish this refusal.
`HerdrWatchStore.spawn` keys the fence by `[fleet, harness, workingDirectory,
resumeSessionOrNew]`, then refuses every settled key before inspecting the new
brief. `DeliveryFence.settled` retains that terminal disposition permanently.
The current API cannot distinguish a new authorized intent in that location
from the abandoned original. Changing a title or conversation does not help.
No location/account/harness/key alias was used to bypass the fence.

Remaining acceptance is precise:

- An explicit new-hire path must distinguish a fresh authorized intent from
  retained originals while preserving original evidence and never replaying them.
  The deployed metadata fix was not reached by this refusal.
- Fresh PC Codex brief, later native follow-up, correlated completion/lead wake,
  inherited tracker isolation and two-owned-pane peer exchange are unrun because
  the first hire could not allocate a pane.
- Claude still reports `loggedIn:false`; native Claude follow-up and Stop
  completion require James's personal `/login` and a subsequent owned-pane check.
- Hand-started PC reply delivery and service-path hired-worker SSH-loss acceptance
  remain unproven. The earlier owned control/SSH-loss result on VUH-1563 does not
  establish those service paths.

[Final read-only census](live/72c1571a/pc-after.json) matches the original five
pane identities and confirms Claude's login status. No test pane was created,
no automated message was typed and no account/config/desktop changed. VUH-1709's
separate owned native hook proof is complete and its ticket is Done.

This checkpoint changes evidence only. The existing native security review and
focused tests/typechecks/scoped lint cover the unchanged recovery/launcher code;
no new heavy tests, full check or eval ran. Evidence JSON validation, formatting,
documentation links and `git diff --check` passed. Leave VUH-1527 In Progress.

## Explicit fresh-intent admission candidate

Clankie authorized a distinct new-work admission after settlement. Public
`spawn_seat`, native `hire_agent` and `clankie hire-receipt fresh --json-stdin`
now accept `freshIntent: {id, afterReceiptId}`. The caller chooses one stable
lowercase UUID and supplies a different explicit brief. The service requires
current captured hiring authority, the exact settled native predecessor in the
same location and its unchanged configured remote target. Original settlement
and evidence remain fenced; there is no resend, deletion or adoption of originals.

Each fresh identity records its owner, resolved project and launch scope, and
finalized brief fingerprint in the existing hire journal. An unresolved sibling
blocks new admission. Exact same-ID retries inspect only that original native
binding, while changed scope, owner, brief or another UUID for the pending work
refuses. Confirmed and proven failed fresh IDs survive restart and age pruning.
Pending project allocation cannot substitute an earlier request for new intent.
Initial and recovered adoption recheck host/project/authority before the final
native occupant observation, then latch live authority synchronously before
adoption and reconciliation.

[Verification](fresh-intent/CHECKS.md) and the independent
[native security review](fresh-intent/SECURITY-REVIEW.md) cover this source
candidate. The isolated integration uses a real Herdr server, OS census, host
journal and authenticated CLI/HTTP request boundary. It deliberately denies native
agent preparation after launch commitment; it proves admission/restart fences,
not a successful Windows Codex turn.

After landing and deployment, use the retained native predecessor
`719dd6b1-2814-4c2b-9eb6-118fb785427c` with a saved new intent to run the PC
Codex hire → brief → follow-up → completion → peer-message acceptance on owned
panes. The earlier five unowned PC panes remain untouched. Claude's personal
`/login` stays with James and does not block Codex acceptance. Leave VUH-1527
In Progress until the deployed live evidence covers its acceptance.

## Deployed 2e1c08be PC acceptance: process-proof refusal

On 2026-10-06, Clankie authorized the Codex PC acceptance on runtime
`2e1c08be6506b0c7d5ed6d18bda34a9b10c0affe`, including fresh-intent admission
`ae3b63fd`. The installed runtime matched that SHA. Fleet `pc` was healthy;
Windows Codex was 0.160.1 and its worker plugin was 0.6.6. The existing five
unowned panes were preserved.

The first request overescaped the Windows cwd and was definitively refused
before admission. The [correction](live/2e1c08be/scope-correction.json) used the
exact retained settlement value with the same fresh UUID and brief. The
[original settlement recheck](live/2e1c08be/original-settlement-recheck.json)
matched the earlier authenticated abandonment evidence exactly.

The [corrected public request](live/2e1c08be/a-corrected-hire-intent.json) used
fresh intent `80741ad0-3fec-4cf9-9932-43bd0ad2b09e`, predecessor
`719dd6b1-2814-4c2b-9eb6-118fb785427c`, and a new hiring conversation
`conv-eba43df2-b0e8-486b-a1ec-f64a76d52ba2`. It allocated `pc/wC:p2`, terminal
`term_65d27c3f464e613`, native session `01a11053-0973-7133-8ab4-099e72cba83c`.
The native Codex TUI started; the [public result](live/2e1c08be/a-hire-result.json)
then returned `start_unconfirmed`, delivery `uncertain`:

> Native hire binding has no matching current process proof; no brief was sent; inspect pane pc/wC:p2; no fallback was started

The service retained native receipt `af9b1c8b-f573-4f74-8d48-ef7bf6287920`, its
[fresh owner/scope binding and irreversible launch flag](live/2e1c08be/a-original-native-receipt.json).
No brief, follow-up or peer message was resent. The TUI displayed “Reconnecting
to server…” after the failed binding; the owned app-server was already absent
at inspection. No startup trust prompt appeared and no trust keys were sent.
This observation does not establish a regression in VUH-1738's trust handling.

Source tracing identifies an address mismatch at the failed boundary:
`HerdrWatchStore.observeHireIdentity` passes fleet `pc` and pane `pc/wC:p2`
directly to `projectHireIdentity`. `index.ts` dispatches that callback to
`createRemoteProjectObserver`, whose first guard requires a bare `w…:p…` pane.
The [deployed observer check](live/2e1c08be/proof-address-check.json) returned no
proof before any fleet lookup or host call. Repair must preserve the exact
fleet, native occupant, process lifetime and socket checks while consistently
mapping qualified Herdr identities to the observer's host-local pane identity.
The stored project assignment and membership lookups also need the same
consistent namespace; weakening the process proof would not address the cause.

| Acceptance                                            | Live evidence                                                                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Explicit fresh intent after retained settlement       | Admitted; owned pane and native process allocated                                                                             |
| Inherited tracker isolation                           | Launcher and native `codex.exe` both carried `mcp_servers.linear.enabled=false`; default PC Linear connector remained enabled |
| Native bridge catalog                                 | Doctor observed `message_clankie`, `clankie_tools`, `clankie_call`, `list_fleet_seats`, `message_peer` on the owned pane      |
| Brief and later follow-up through app-server          | Blocked before brief by native process-proof refusal                                                                          |
| Correlated completion and hiring-lead wake            | Unrun because no brief reached a model                                                                                        |
| Owned-pane peer exchange and worker-side tracker read | Unrun because hire did not return a bound seat                                                                                |
| Hand-started reply and hired-worker SSH-loss outcomes | Remain unproven; unrelated panes/link were untouched                                                                          |
| Claude channel/Stop completion                        | Still needs James's personal `/login`; it did not block this Codex attempt                                                    |

[Tracker/process evidence](live/2e1c08be/tracker-and-process-proof.json) records
the actual owned process chain and its override flags without credentials or
full command lines. [Native catalog evidence](live/2e1c08be/owned-native-catalog.json)
records the observed worker tools. It does not claim the model used those tools.

Cleanup closed only the test's `wC:p2` and its empty workspace root `wC:p1`,
after checking their exact terminal identities and the absent owned backend.
[Final census](live/2e1c08be/cleanup.json) matched all original five pane/terminal
identities. [Captured owned processes](live/2e1c08be/owned-process-cleanup.json)
were absent. The PC's Codex config target and SHA-256 stayed unchanged.

The supported operator CLI then recorded the failed fresh native receipt as
[abandoned with authenticated evidence](live/2e1c08be/fresh-failed-hire-abandoned.json):
five panes, 546 processes and four sessions; its allocation was absent. Both
original and fresh records remain retained and permanently fenced. A later
acceptance must use a separately authorized new intent after the binding fix,
never this brief or UUID again.

This checkpoint changes evidence only. JSON validation, scoped formatting,
documentation links and `git diff --check` passed. The source candidate's prior
focused checks and security review remain source evidence; they do not certify
this live failure. No new heavy suite, full check, eval, account/config change,
desktop action or unrelated pane mutation ran. Leave VUH-1527 In Progress.

## Deployed 4124acab PC acceptance: native sender refusal

Runtime `4124acabe87da6fb225ecfc53f77101a17ff5a9c`, 2026-10-06.
The [new intent](live/4124acab/a-hire-intent.json) is
`293c21f9-2602-4c20-a6b5-c9ad686a65b1`, after the unchanged authenticated
[719dd6b1 settlement](live/4124acab/original-settlement-recheck.json). No earlier
intent was resent. Owned lead: `conv-0da6937a-0e21-413e-b0c3-2261da81df5e`.
Owned Codex pane: `pc/wD:p2`, terminal `term_65d28d44cce3f15`, native session
`01a11098-decc-7603-9a31-998a3048e17f`.

| Check                                  | Live result                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fresh hire and pane-address proof      | [Spawned, brief consumed](live/4124acab/a-hire-result.json); [original qualified process allocation confirmed](live/4124acab/a-confirmed-project-allocation.json); [doctor assigned/eligible](live/4124acab/doctor-owned-membership.json).                                                                                                                               |
| Brief, worker tools and tracker access | Worker returned `TESS1527_412_a_BRIEF_OK`, exposed all five expected Clankie tools, and successfully read VUH-1527 through `clankie_call`. Independent Linear tools were absent from its native catalog. [Owned native UI](live/4124acab/owned-native-worker-ui.txt).                                                                                                    |
| Launch isolation                       | [Backend and visible launcher/native TUI](live/4124acab/tracker-and-process-proof.json) carried `mcp_servers.linear.enabled=false`. Default PC Linear remained enabled; config source/hash remained unchanged.                                                                                                                                                           |
| Native lead follow-up                  | Clankie called `message_seat` once for a separate new intent: delivered/consumed, message ID `01a110a0-e3d7-7fc3-92df-82e9693afc69`. Worker returned `TESS1527_412_a_NATIVE_FOLLOWUP_OK`. [Native lead events](live/4124acab/native-lead-events.json).                                                                                                                   |
| Native completion                      | [Both native turns completed](live/4124acab/a-native-completion.json); follow-up receipt ID exactly matches the completed native turn. The original hire completion was harvested by its owning lead, which woke at 09:44:46Z after native completion at 09:44:43Z.                                                                                                      |
| Worker reporting and peer exchange     | Both worker `message_clankie` calls rejected: “No durable native binding is available; nothing was sent.” Model `list_fleet_seats` returned `403 native_peer_sender_required`, without a receipt. No peer message or second test hire was attempted after that sender refusal.                                                                                           |
| Public child-conversation follow-up    | [Refused `seat_offline` / unavailable](live/4124acab/a-followup-result.json) despite the live native pane. The hire result and [roster](live/4124acab/owned-roster.json) carry different persona IDs for the same seat/occupant; this is mapping evidence, not proof of the cause. The subsequent native lead request was a distinct message, never an uncertain resend. |

Remaining gaps: native sender binding for worker reports/peer discovery and a
real owned-PC peer exchange; public child-conversation mapping; follow-up
completion wake (no later owning-lead wake appears through 09:59:50Z after its
09:52:37Z native completion). The original completion harvest does not prove
that later wake. Hand-started replies, hired-worker service-path SSH-loss outcomes,
and Claude channel/Stop completion remain unproven; Claude still needs James's
login and did not block this Codex attempt. No TUI reconnect failure or startup
trust input was observed, so no new VUH-1738 observation is claimed.

[Cleanup](live/4124acab/cleanup.json) closed only the native owned worker and its
owned empty workspace root `wD:p1`. The captured backend/TUI/wrapper/root PIDs
are gone, all five [baseline pane identities](live/4124acab/pc-baseline.json)
are preserved, and the Codex config target/hash match. One SSH handshake reset
occurred before the root-cleanup script could start; the checked cleanup then
succeeded. The [successful hire receipt](live/4124acab/a-retained-native-receipt.json)
remains retained as completed. No receipt, account or configuration was erased.

Tess's own Mac [report bridge now stores messages](live/4124acab/tess-report-receipt.json).
Her targeted refresh returned `skipped-busy`; that sender's working report does
not establish the PC worker's binding. Native peer tools are now exposed to Tess,
but Pell was absent from her admitted recipient list, so the handoff still goes
through Clankie.

This is an evidence-only checkpoint: 16 JSON artifacts, exact cleanup/identity,
native turn/receipt and original-settlement assertions, scoped formatting,
documentation links and diff checks. No new source suite, full `pnpm check`, eval,
simulator, account/config change, desktop action or unrelated pane mutation ran.
Leave VUH-1527 In Progress.
