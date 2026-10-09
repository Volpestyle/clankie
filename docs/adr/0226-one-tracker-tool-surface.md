# ADR 0226: One tracker tool surface

Status: accepted (James, 2026-10-05). Tracks [VUH-1665](https://linear.app/vuhlp/issue/VUH-1665).
Amends the tool vocabulary, priority and disconnected behavior of
[ADR 0191](0191-work-is-tracked-where-the-repo-tracks-it.md).
Amended by [ADR 0243](0243-linear-graphql-is-the-tracker-escape-hatch.md):
`linear_graphql` reaches the rest of Linear's API beyond this subset.
A proposed
[ADR 0181 amendment](0181-clankie-is-independent-of-his-connections.md#amendment-the-built-in-tracker-is-the-default-2026-10-09-vuh-1904)
(VUH-1904) grows the built-in default tracker from the durable local backend and
makes Linear an optional connection; these tools stay the agent vocabulary.

## Context

Clankie and his workers already know the Linear tools and writing skills.
Separate `work_items` tools force them to learn another vocabulary, and losing
the Linear connection removes that familiar surface. James requested “a mirror
of linear tools locally, for fallback if we're not using Linear.”

## Decision

Expose the same `linear_*` names and input shapes through the existing service
tool directory to Clankie and workers. The supported subset covers issue
reads, lists and search; issue upserts and atomic description patches; state,
priority, labels, parents and relations; comments and replies; projects and
project status updates. Identity, team, state and label discovery support the
same writing and orientation skills. Unsupported provider features must fail
explicitly, rather than silently discard input.

Choose the owner-connected Linear backend when connected, retaining its
credential, account, lane and dispatch fences. Otherwise use durable local
service storage. A failed connected call never switches backend or replays a
mutation. `clankie doctor` identifies the active backend and why it was chosen.
Local identity is visibly local; it is not a fabricated verified Linear account.
Fleet admission and its kill switch continue to apply to both backends.

Repository conventions still select GitHub or Markdown storage. Their adapters
project that storage onto the same tools; repository selection is explicit.
The existing `clankie work`, device API and receipt-backed narrow writes remain
compatibility callers of the common contract. They retain repository admission,
fresh-read merges and uncertain-write handling. Ancillary local records belong
to the same repository scope, rather than a second task queue.

Priority is `0` (none), `1` (urgent), `2` (high), `3` (medium), `4` (low) on every
backend. Open-work lists sort urgent through low, then unprioritized, before
pagination or limits. Markdown stores priority as front matter; GitHub uses
reserved priority labels; Linear retains its native field.

Connected issue lists collect provider pages once into an account/configuration-
bound sorted snapshot. Identical concurrent reads and public cursor pages share
that scan for 60 seconds; failures have a 30-second retry floor. The host retains
at most 32 listings. Cursors name the snapshot and require a restarted listing
after expiry or invalidation, preventing mixed pages. Each caller still passes
its own lane, grant, account and revocation checks, including after a shared read.
Writes invalidate at dispatch and settlement (also after uncertain failures),
and verified webhooks invalidate before self-echo suppression. A connection
change or shutdown retires snapshots. No mutation is cached or retried. Host
call logs include the actual provider-page count, including zero for cache hits.

Local records have immutable UUIDs and stable human identifiers. Writes lock
the durable store and replace it atomically. Patch anchors must match current
content; a failing operation aborts the entire mutation. Labels replace only
when explicitly supplied; relations append as in Linear. A local record remains
local when an account is connected; no automatic migration or synchronization
is implied.

```mermaid
flowchart LR
  Agents[Clankie and workers] --> Tools[linear_* tool directory]
  CLI[clankie work / device compatibility] --> Tools
  Tools --> Selection{backend binding}
  Selection -->|connected| Linear[owner-connected Linear]
  Selection -->|disconnected| Local[durable local store]
  Selection -->|explicit repository convention| Repo[GitHub / Markdown adapter]
  Selection --> Doctor[doctor: backend + reason]
```

## Export and import

A future explicit export is a versioned bundle containing source store UUID
(the local store's persisted team UUID),
record UUIDs and identifiers, full content, priorities, state and label metadata,
projects, comments and replies, relations, and timestamps. Import requires an
owner-selected connected account, team and project mapping. It creates projects
and issues first, records a durable `(store UUID, record UUID) → Linear UUID`
mapping, then resolves hierarchy, relations, status updates and comment threads.
Each mutation records intent and its provider receipt before continuing. A
rerun reconciles the mapping and uncertain receipts instead of duplicating
records; unmapped labels or states require a decision. Export/import execution
and automatic synchronization are outside this change.
