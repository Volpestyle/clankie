# Original-hire project membership read checkpoint

VUH-1534, 2026-10-04. This is an opt-in owner read projection in an isolated source
checkpoint. It is not yet a claim of deployed support or completed app placement.

`POST /v1/operator/fleet-membership/read` accepts `schemaVersion: 1` and one to eight
unique seat tuples (`seatId`, current roster `occupantId`, optional `fleet`). The
CLI and console expose `project membership SEAT_ID OCCUPANT_ID` for a local seat.
Read both IDs from the current fleet roster. They correlate a request; they do not
prove an agent or select a project. The service reads native roster/process facts
and the existing original-hire ledger itself.

A successful member entry names `projectId`, source `hire`, and an optional
explicit hire role. An absent role stays absent. There is no implied builder
station, persona-role fallback, working-directory assignment, control availability,
delivery receipt or tool permission. No process proof, native session ID, private
path, bearer or allocation token is returned. All responses are no-store.

## Supported source path and limits

The first subset covers confirmed original local hires whose saved proof can be
reproduced by the existing macOS generic process observer. Local Codex's current
production adapter starts its visible TUI through the normal Herdr shell tab,
reports its exact thread, and calls the internal bound callback. That callback
requires and stores this generic foreground proof before the hire can confirm.
The separate private app-server is not substituted for that TUI process. Local
Claude records a generic proof when available; a historical missing first proof
cannot be filled in later.

The observer compares the original foreground process and shell lifetimes,
installed native executable/script, Herdr binding, terminal and native session.
It retains the existing `ps lstart` second-level birth representation. This is
weaker than a retained kernel process handle or microsecond birth observation;
this feature does not claim stronger PID-reuse precision. It reuses that existing
proof for display provenance only and does not change admission or tool policy.

Prepared OpenCode/Pi direct roots, unsupported private/wrapper topology, remote
hosts and owner-started agents return unknown. A prepared root uses a different
libproc lifetime contract that this generic observer cannot reproduce. No saved
PID/session is reconstructed into a new proof. A retired controller alone does not
remove a still-observable original generic hire's membership. Conversely, an
attached controller is not membership evidence. Cold reads require the same fresh
original proof; there is no adoption, reattachment, native launch or history read.

Only the latest confirmed, started, non-gone allocation with its original first
proof qualifies. Invalid historical hires never fall back to cwd. Current project
and explicit-role existence are revalidated. Model, effort and numeric-cap changes
do not retroactively move an existing hire to another project or role. Cwd changes
on the same original hire also do not transfer its intentional project assignment.

## Freshness, authority and resource bounds

The endpoint uses the same current owner operator/Take Control device authority
as project configuration reads. A model-only credential cannot call it. Every
waiter reauthorizes independently, including after native work. Settings revision,
original allocation and current binding are rechecked before publication. Initial
and final process proofs plus native roster/session/terminal observations must
agree. Changes during waits return unknown or a refused read, never a stale member.

These are bracketed observations, not an atomic freeze of a process or an authority
lease. A process or credential can change immediately after its last check. Clients
must discard on disconnect, replacement, new settings, an unavailable/refused read,
a superseding request, or receipt expiry. The pure client applicability helper uses
the current roster generation and monotonic request age with a five-second ceiling.
The app's poll/placement lifecycle is a separate follow-up; this checkpoint does not
wire or claim it. A roleless member belongs in an unassigned area, not an invented
builtin station.

Existing strict fleet DTOs and default fleet clients remain unchanged. The separate
read cannot delay a fleet snapshot. New clients explicitly opt in; old-host 404,
405 or 501 means unsupported. Failed authentication and server errors are not
reported as empty successful membership.

At most four batches and four active native observations exist globally per service
instance. Every initial, shared-final and per-reader roster read uses the same
four-slot pool as process proof reads. A batch accepts at most eight seats and 32 coalesced readers. Concurrent
identical requests share initial observation only; each authorized waiter gets its
own fresh final proof and roster guard. The coalescing key is the input, project
settings revision and host binding; allocation tokens are not part of that key.
Fresh final ledger guards reject a shared observation after allocation replacement.
There is no positive or negative result cache. All native work shares one five-second batch deadline. Subprocesses have
bounded output, a timeout and an abort signal. Slots remain occupied until their
own children close; cancellation does not abandon a `Promise.race` task. The last
waiter cancels the batch. Settings/auth/filesystem promises do not all support
physical cancellation; late completion is fenced, not described as instant cleanup.

## Verification boundary

Focused deterministic fixtures cover the real ledger, first-observation retention,
confirmation, cold ledger reads, session/PID/birth/shell/binding/terminal changes,
policy removal, held authorization replacement, no-role/cwd behavior, owner route
mounting, strict DTO compatibility, old-host fallback, CLI correlation and privacy.
Actual temporary device pairing and signing fixtures cover current Take Control
access, chat-only/model-only/unknown/revoked devices, a different signing key, and
revocation held across the final authorization wait. No owner device is used.
Concurrency fixtures cover the global four-observer cap across held roster and
process reads together, bounded batches,
coalescing, per-waiter revocation, deadline, no cache and cleanup. An owned short-lived
Node helper verifies abort waits for child exit and output bounds; no agent process
is observed or controlled by that fixture.

Mock observer success is not a native agent compatibility or latency measurement.
No live native agent, owner settings, remote fleet, provider, model or eval was used.
A native owner read and later app integration remain unverified. The whole VUH-1534
placement feature remains incomplete beyond this API/CLI foundation.
