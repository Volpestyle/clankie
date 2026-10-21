# ADR 0286: One body holds Clankie at a time

Status: accepted direction (James, 2026-10-20, [positioning decision](https://linear.app/vuhlp/document/clankie-positioning-draft-1a1d7434ba9e));
protocol tracked by [VUH-2577](https://linear.app/vuhlp/issue/VUH-2577).
Builds on [ADR 0181](0181-clankie-is-independent-of-his-connections.md) (identity
belongs to the service), [ADR 0244](0244-machines-join-clankie-at-an-access-level.md)
(machines join at an access level), [ADR 0232](0232-hosted-connections-use-the-body-broker.md)
(credentials stay in the body broker) and [ADR 0285](0285-hosted-presence-has-no-idle-clock.md),
which left local-to-hosted continuity to this decision. Credits-only managed
bodies (VUH-2576) are unchanged.

## Context

Clankie's identity, memory, conversations and work live in one service's state
directory. A Mac and a hosted body are the same software, but nothing names
"this Clankie" across them: there is no stored self id, epoch or authority
record. Getting started says pairing does not move a local Clankie to hosted.
Copying a state directory by hand would start a second Clankie with the same
history. Both would answer Discord, write memory and run Auto rounds, and their
histories would diverge with no way to merge them.

Some state cannot move at all. Broker secrets, the device-session key, paired
devices, the gateway host identity and machine joins are bound to one body or
one machine. Absolute workspace paths name directories on the machine where
they were registered.

## Decision

**One self, one active body.** Each body keeps a self record,
`<state>/self.json`: `selfId` (random, minted at the first transfer), a
monotonically increasing `epoch`, and a `state`:

| State      | Meaning                                                                    |
| ---------- | -------------------------------------------------------------------------- |
| `active`   | This body is Clankie. A missing record means active with no transfer yet.  |
| `frozen`   | A transfer out has begun. Nothing new is admitted; the snapshot is stable. |
| `released` | Clankie lives elsewhere now. The record names where and at which epoch.    |

Only an `active` body runs Clankie. A body that starts `frozen` or `released`
starts **dormant**: it serves `/health` (which reports the self record) and the
owner-only transfer routes, and nothing else. No captain turn, Discord mouth,
voice, relay intake, Auto round, tracker loop, webhook or device admission
runs. A dormant body never makes itself active. Only importing a bundle with a
higher epoch, or the explicit owner reclaim below, can do that.

**Transfer is freeze, copy, activate, release.** `clankie transfer` drives
it with the owner's operator authority on both bodies:

```mermaid
sequenceDiagram
  participant CLI as clankie transfer (owner)
  participant S as Source body
  participant D as Destination body
  CLI->>S: freeze(transferId, destination)
  Note over S: waits for no turn, voice or share;<br/>persists frozen at epoch e+1, then restarts dormant
  CLI->>S: GET bundle
  S-->>CLI: manifest (selfId, epoch e+1, transferId, sha256 per file) + files
  CLI->>D: stage(bundle)
  Note over D: verifies hashes and admission;<br/>stores under transfer/incoming
  CLI->>D: apply(transferId)
  Note over D: idle cutover, restart; on boot applies the stage<br/>and writes active at epoch e+1
  CLI->>D: status → active, selfId, epoch e+1, transferId
  CLI->>S: release(transferId, destination receipt)
  Note over S: released at epoch e+1 (tombstone)
```

1. **Freeze** waits until no captain turn, voice stay or activity share is
   running, closes admission the way a release cutover does, persists `frozen`
   with the new epoch and transfer id, and restarts. Worker panes are not
   waited for: they keep running on their machine. Freezing is persisted before
   shutdown, so a crash or restart cannot resume an active source.
2. **Export** runs only on a dormant source, so nothing writes the files being
   read. The bundle carries a manifest with `selfId`, the new epoch, the
   transfer id and a SHA-256 for every file.
3. **Stage** verifies every hash and admits the bundle only when the destination
   is either unclaimed (no self record and no Clankie history of its own) or
   `released` for the same `selfId` at a lower epoch. A destination with its own
   independent history refuses; the owner may explicitly replace it, which
   archives that history under `transfer/archive/` rather than merging.
4. **Apply** happens at the destination's next boot, before any store opens.
   The paths the bundle replaces are archived first. Only then is the self
   record written `active` at the bundle's epoch.
5. **Release** happens only after the CLI has read the destination's activation
   (`active`, same `selfId`, epoch and transfer id). The source becomes a
   tombstone naming the destination.

At every step at most one body is active: the source stops being active before
the snapshot exists, and the destination becomes active only from that
snapshot. Between freeze and activation, no body is active. Messages wait for
Discord's own catch-up, and app clients show him unavailable.

**Uncertainty keeps the source frozen.** If any step fails or its result is
unknown, the transfer resumes with the same transfer id; it never starts a
second one. **Abort** returns the source to `active` only after the destination
confirms that it has not applied that transfer and has burned the transfer id,
so the destination can never apply it later. A destination that cannot be
reached leaves the source frozen. `clankie transfer reclaim --force` is the
owner's explicit way out. It reactivates the source at a still higher epoch and
is recorded with the warning that any work the other body did is not merged.
Each epoch and transfer id is applied at most once. A body refuses a bundle
whose epoch is not above its own.

**What moves** is what Clankie knows and has said:

- identity: the self record, persona and appearance, Discord ownership and room
  settings, fleet working preferences, autonomy and trust settings;
- memory: episode notes and person facts;
- conversations: the conversation registry, archives, Pi sessions, room turns
  and their delivery receipts, the fleet room, attachments, routines, goals and
  Auto round history;
- projects: project settings, with workspace bindings rewritten below;
- tracker: the built-in tracker and its imports, registered repos, Linear
  bindings and write and wake receipts, saved views and evidence.

**What stays** binds a body to its machine, accounts or devices: the credential
broker (Keychain on a Mac), model and harness sign-ins, connected-account
tokens, the device-session key, paired devices and the event log they replay
from, gateway and hosted host identity, machine joins and ssh machines, Herdr
bindings, hire records of live panes, and service logs. The manifest lists what
stayed, so nothing disappears silently. After a transfer the owner pairs devices
to the new body and connects accounts there through its own broker
(ADR 0232). A managed destination stays credits-only. A Mac that gets Clankie
back still has its own broker entries, so its connections work again
without a new sign-in.

**Linked machines become execution resources.** A workspace registered on the
source's `local` machine is rebound to the source machine's id on the
destination. A transfer to hosted joins the source Mac to the hosted body
(`clankie join`, ADR 0244) at the access level the owner approves, so its
checkouts, Herdr and tools remain where Clankie's workers run. The joined
install already refuses to start another Clankie there. Existing worker panes
stay open; their hire records move as history, and new hires go through the
join. Other machines linked to the source join the destination the same way.

**Return uses the same protocol.** The hosted body freezes and exports. The Mac,
`released` for the same self at a lower epoch, accepts the bundle and becomes
active at the next epoch. The hosted body becomes the tombstone, and the Mac
leaves its join.

## Consequences

- "The same Clankie" copy may describe a transfer only after this protocol is
  proven end to end with real data.
- A transfer interrupts presence for the length of one freeze, copy and restart.
  It is an explicit owner action, never automatic failover.
- The gateway carries the transfer routes inside the encrypted device envelope,
  in envelope-sized chunks, for an owner device with Take Control
  ([VUH-2582](https://linear.app/vuhlp/issue/VUH-2582)).
- A dormant body keeps its doorway ([VUH-2583](https://linear.app/vuhlp/issue/VUH-2583)).
  It runs the active body's own app composition (device authority, hosted
  security, the hosted-operator seam, the gateway connection) with no captain,
  behind a gate that admits only health, transfers and device session upkeep. It
  is not a gated full service: nothing else of Clankie starts. A frozen body
  builds its bundle at boot, before anything else opens. "Dormant" describes the
  process, so a body still shutting down after its own freeze never exports.
- Two bodies never merge state. Reclaim is the only path that can leave two
  histories, and it requires `--force` and is recorded.
