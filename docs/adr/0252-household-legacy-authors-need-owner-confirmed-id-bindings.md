# ADR 0252: Household legacy authors need owner-confirmed ID bindings

Status: Accepted (2026-10-08), VUH-1834. Extends ADR 0251.

## Decision

Discord feedback continues to record the authenticated speaker's numeric ID.
The owner can explicitly bind an exact legacy author label to that ID within
one household through the revision-fenced Discord settings API. Display names,
message claims, case folding and inferred aliases never establish identity.

`discord.houseHuntingAuthorBindings` is an Advanced list. Each entry contains
`household` (`existing` or the numeric `SERVER-CHANNEL` household key), `userId`,
`legacyAuthor`, and required `ownerConfirmed: true`. A legacy label belongs to
only one ID in a household; one ID may have several separately confirmed labels.
Numeric authors are already IDs and cannot be bound as legacy labels. Empty,
padded and control-character labels are refused. There are no defaults or
personal bindings. Omission by older clients preserves the list.

API writes retain the existing authenticated operator boundary and revision
fence. CLI `discord legacy-author ... --confirm` and TUI Advanced make the
specific household, label and ID explicit before saving. Workers must obtain
the owner's confirmation for each real binding, rather than infer it from a
conversation or directory. They do not change live settings for this landing.

Creating a binding does not change any decision or merge old feedback. Only a
new `reconsider` from its authenticated ID can close the bound legacy author's
outstanding rejection. The adapter reads bindings again at execution. Other
people's ID and legacy decisions remain independent. Removing a binding stops
future use; it does not undo an already authorized reconsideration.

The ledger appends a new ID-attributed feedback row and explicit legacy targets
atomically. Original rows, authors and notes remain intact. Rejection filtering
folds those targets in sequence, so a later rejection still excludes the home.
The canonical house-hunting skill owns this portable ledger behavior; Clankie's
bounded adapter supplies only the targets authorized by its household settings.
No alias-writing operation or author parameter is added to the room tool.

## Verification and rollout

Use isolated settings and a disposable real Python/SQLite household to verify
unbound rejection continuity, exact scope, authenticated attribution, explicit
reconsideration, other authors, revocation, stale writes and older-client
preservation. App and hosted Advanced editors consume the same setting contract.
Clankie deploys and checks the real legacy household; that live acceptance stays
open on VUH-1834. No worker reads or rewrites its live ledger or settings.
