# VUH-1963: read-only Linear mirror import

The real Clankie Work project was imported into an owned scratch tracker and
scratch instance of the existing evidence store. Linear remained authoritative;
no Linear mutation, live tracker write, backend switch or deploy was performed.
The connected actor was the Clankie workspace OAuth app, verified before import.

## Import and rerun

The final source capture contained 28 issues (0 archived), 46 comments/replies,
64 state spans, 45 label records, 56 unique relation records, one project,
six milestones, one document, two project updates, zero team cycles and two
source actors. Eleven authenticated upload downloads became evidence links.
The five spot checks were VUH-1905, VUH-1933, VUH-1919, VUH-1962 and VUH-1907.
Independent connected-account reads checked their IDs, priorities, states,
comments and relation graphs. Project collection reads independently counted
28 issues, six milestones, one document and two updates, with no next page.

A stable-source rerun used 282 GraphQL reads, created/updated zero records,
returned 187 unchanged source records and left `tracker.json` byte-identical.
The first earlier rerun correctly updated one issue because VUH-1962 completed
in Linear during the first capture; this is retained as changed-source evidence,
not described as a no-op. The initial report counted GraphQL reads separately
from the eleven downloads; the final implementation counts both wire kinds.

The raw capture, reports, source reads, five issue graphs and verification scripts
are published in [the import proof](clankie://evidence/sha256/dac9fac7a59e0389f8f89dfd04854447f58acd9a31bbfc6cf9ef89637ccc5b58).
All eleven original blobs and that proof were published with
`clankie evidence push docs/testing/2026-10-09-linear-import --issue VUH-1963`:
12 applied receipts, no failures. [The manifest](evidence.json) lists every link.
All eleven blobs were opened through the scratch store's signed evidence route
and their hashes verified; the same hashes are now in the canonical evidence store.

After the workspace rebase, the final native mapper imported the same independently
checked source capture into a fresh scratch store: 187 created records. A rerun
created/updated zero, returned 187 unchanged, and left the journal byte-identical.
The original dated capture is reused; these are not claims about newer Linear edits.
Five independent issue spot checks and all eleven signed blob reads passed again.

## Contract checks

Five captured-data integration cases verify reopen/rerun idempotency, native
mapping and source timestamps, archived/reply/historical cycle variants, actor
provenance, no owner asks/rollover, and milestone/document sync plus source updates.
The real project had no archived issues, replies or cycles; those variants are
explicit acceptance cases in the integration fixture, not claimed as live proof.
Original authors remain when worker names merely appear in prose.

No webhook mirror, cutover, multi-team mapping or team-wide import ships in this
slice. The command imports one single-team project into a named scratch store.

Final focused check: work-items, Clankie and TUI typechecks passed; 11 integration
tests passed (five import and six tracker sync). Added proof covers distinct durable
store IDs for two imports of the same team, actor-binding-only changes and workspace
bootstrap containing the reserved `milestone`, `document` and `status_update` models.
The root landing gate runs after commit/rebase; its fixed base, SHA and result are
reported on VUH-1963. No live tracker write, deployment or backend cutover.
