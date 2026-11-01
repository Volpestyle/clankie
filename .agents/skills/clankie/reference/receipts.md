# Receipts and delivery

Detail for [Working beside Clankie](../SKILL.md): what each delivery and tool-
call receipt proves, and how to reconcile one that is uncertain. The rule in
every case: keep the original receipt, read it, and never resend the same intent
through another path.

## Report receipts

Claude seats forward native questions to their exact hiring conversation. An
operator or lead seat with no such conversation keeps `AskUserQuestion` in its
own pane's native prompt; this does not create an app ask or supply an answer.
Notification failures include a credential-redacted cause in the hook reason
and service log. Permission prompts remain denied if notification fails.

Sender progress also arrives as `worker-report-receipt` channel events: stored,
taken into a lead turn, then acknowledged. They never wake you on their own;
they arrive with your next real event, such as your lead's next message, and
`message_clankie_status` reads a report's stage meanwhile. These are receipts,
not new assignments; no reply is needed. The acknowledgment includes the lead's
short summary and resulting links when supplied, but only once a message from
your lead has reached you after the report. Otherwise it says no reply has
reached you, and any question or blocker in that report is still open. Transport acknowledgment of an
event does not mark your report read by the lead.

## Connected-call failures and receipts

Worker connected-tool reads return or explain failure within thirty seconds,
including initialization and response-body reads. The wrapper and enabled peer
tool schemas stay present during temporary provider/discovery failures; calls
still prove current admission and account or native peer authority. A timeout
does not authorize replaying a mutation. Doctor and roster `workerTools` show
observed missing/stalled catalogs and reasons; `not-observed` proves no failure.
Authenticated failures retain their service reason; unauthenticated refusals are generic.
`fleet_admission_unavailable` means current proof is temporarily unavailable,
not that your seat is outside the fleet. Claude and Codex bridges retry this
explicit pre-forward refusal once after a short wait. If it persists, retry
shortly and report the exact refusal to the lead for inspection; do not ask the
owner to admit an already-linked seat. `local_process_membership_required` is a
definite non-member refusal: automatic polling goes quiet; ask the lead to
inspect admission. A worker startup hook leaves an inherited missing pane
unclaimed when Herdr returns `pane_not_found`. Never substitute
another account or bridge. Only the explicit pre-forward refusal is safe to
retry; a later refusal cannot settle an earlier uncertain call.
Connected calls return a `receiptId`. If a dispatched call times out, its typed
`outcome: uncertain` means it may have applied. A tracker read the provider
refused (an unknown issue, say) instead returns `isError: true` with the
provider's message; that answer is definite. Call `clankie_call` with only
`{receiptId}` to read the original result; never repeat its name and arguments.
The bridge keeps that ID even when the HTTP reply is lost. Receipt lookup proves
current admission, tool grant and account binding and never dispatches a write.

## Inspecting and abandoning an uncertain READ

An uncertain receipt can also be inspected, and a proven READ abandoned:
`clankie_call({receiptId, action: "inspect", abandonmentId?})` and
`{receiptId, action: "abandon-read", reason}`, or natively
`clankie agents call-receipt inspect ORIGINAL_UUID [--abandonment-id UUID]` and
`clankie agents call-receipt abandon-read ORIGINAL_UUID --reason TEXT` (nonblank,
at most 500 characters). Both use the calling seat's own fleet link; there is no
operator credential fallback. Inspection reports what the receipt retained
(classification, whether it is abandonable and why not, execution, abandonment)
and never replays the call. Only an original whose receipt kept a backend-owned
`builtin-strict-no-effect/v1` READ snapshot and its native session can be
abandoned, from that same session with current access and the original route:
built-in `get_issue` or `get_user` on an initialized store (and `list_runs` only
on a tracker without a host runner, so never on the service's own).
Initialization, cycle rollover, writes, remote providers and repository-routed
calls stay UNKNOWN; names and caller assertions supply no READ proof. Manual grants
and selectors over 1 KiB are ordinary reads with no census. A settled READ whose
proof was trimmed still reports READ, but it can't be abandoned. A READ that
throws after its snapshot, such as a mistyped key, settles as `confirmed-error`.
Abandonment records one decision to stop waiting; it neither cancels nor proves
nonexecution. A different decision is refused with `abandonment_conflict`, and an
unproven original with `original_read_unproven`; neither records anything. After
an uncertain abandonment reply, inspect with both IDs; never resend abandonment
or the original. Receipts made before this contract retained no
classification and stay UNKNOWN for good.

## Message claims

Keep an uncertain original receipt and reconcile it through the bridge's read
path. Never send the same intent again, switch bridges or remove receipt state
to bypass uncertainty. While the original is unresolved, another call reads only
that receipt. After it settles, a different `message_clankie` follow-up remains
unsent; invoke again deliberately if that message is still needed. A different
`message_peer` follow-up goes out in that same call, and its result carries the
original's settled outcome as `previous`. For `message_clankie`, a recovered
positive keeps a five-minute reconciliation window: matching text returns its
original stored ID, including after a bridge restart. Starting a distinct fresh
report closes that window; after expiry, the same text can be a new status report.
Ordinary successful sends do not open this window, and unresolved claims never
expire because of it. A confirmed delivery means the stated native handoff;
it does not prove the recipient model read it or accepted its authority.

A refused connection before an inbound POST reaches the service releases only
that exact claim. An authenticated definitive unknown-delivery lookup also
releases it after the service seals the original ID against delayed delivery.
After a restart or the host request deadline, that lookup can settle an exact
abandoned pane claim whose message was never accepted. Live requests, accepted
history and mismatched or unreadable evidence remain protected. Keep the claim
and use its lookup; do not delete it or replay the original to recover.
Neither sends a replacement in the same invocation. Timeouts, connection resets,
unverified lookups and mismatched evidence retain the uncertain original.

`recipient_gone` with outcome `unconfirmed` is terminal: the original recipient
lost its binding, so delivery stays unknown and must never be resent. The bridge
clears that original claim; a later deliberate call may send fresh intent.
`superseded` with outcome `unconfirmed` is also terminal: nothing proved or ruled
out delivery within 15 minutes. The original is never resent; a different message
to that seat goes out in the same call, labelled as following the unresolved one.
An unresolved original holds only its own recipient; messages to other seats go
out. The service prunes older settled bodies after 100 messages, retaining
exact receipt identities; unresolved originals keep their full bodies.

## Claude seat delivery

Fresh Claude hires stage the brief in a private JSON file and submit one short
native CLI prompt referencing it. The full brief never crosses Herdr’s shell
argument encoder. Even a plain lead brief gains multi-line working preferences
before launch. Settings and inline system/config text also use native file forms;
other control-bearing arguments refuse before launch. Never send a second channel copy. Confirmation requires the
complete decoded file attachment in the exact native transcript; a bridge stdout ACK alone is
insufficient. A slow transcript leaves `delivery_unconfirmed` / `uncertain`,
not permission to resend. Inspect or reconcile the original hire. Its observed
session keeps the hiring conversation even when startup fails. The roster's
persisted startup-failure summary and the existing hiring-conversation wake
surface a missing first turn. A pending pane claim grants no native authority.
Failed starts return `receiptId`. For an old local failure that omitted it, the
operator can settle its unique original with `clankie hire-receipt settle
ALLOCATION_UUID abandoned`, then `release-allocation` after complete pane-absent
inventory. Settlement never replays the brief or claims it was delivered.

Claude sessions with an observed, process/session-bound worker prompt hook can
receive held replies once at the next `UserPromptSubmit` without `--channels`.
A live channel can deliver immediately only when Claude was launched with
Clankie's worker loaded for that session (`--plugin-dir` with
`--channels plugin:clankie-worker@inline`, ADR 0317) and the policy allows it;
reconnecting the plugin alone does not enable a channel in an original process. The roster's `messageReceiver` names `live` (an exact-session native
poll, not model awareness), `next-turn-only` (an observed prompt hook without
a live poll), or `unverified`. Next-turn-only is an idle-wake limitation even
with no queued mail; it stays visible in the TUI and in the adoption/message
receipt. Its detail gives the original session's channel-enabled resume command:
`claude --resume SESSION_ID --plugin-dir <that machine's Clankie worker plugin
folder> --channels plugin:clankie-worker@inline` (a prepared Mac pane's
`claude --resume SESSION_ID` adds both).
Coordinate stopping/resuming that session with the owner, retaining its original
cwd and account/config home; never launch a duplicate of a still-running session.
An absent live poll can also mean a disconnected bridge, so inspect before
choosing recovery. Queued originals carry `waitingMessages` on the owner roster and a
body-free owner update naming the pane. `stored` awaits the next prompt;
`unconfirmed` awaits hook output acknowledgment and must not be replayed.
The TUI keeps an idle lead with either state visible. Never type a fallback draft
into a pane to compensate for missing native delivery. No observed compatible receiver means
unavailable; a later pane occupant cannot inherit earlier mail. Codex's worker
plugin supplies tools and skills, not a Claude-style next-turn hook; inspect its
actual native control receipt separately.

## Codex follow-ups

An accepted Codex follow-up automatically watches its native turn for the current
lead. Completion of an earlier turn cannot settle it; reconciled receipts reuse
the original harvest. Peer output creates no owner completion wake. An unavailable
controller remains explicitly unverified; a delivery receipt alone is not completion.
