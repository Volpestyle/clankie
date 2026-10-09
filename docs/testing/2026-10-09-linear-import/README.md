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

The scratch proof's raw captures, reports, source reads, five issue graphs,
SQLite metadata and scripts remain local in `.local/linear-import/`.
All eleven blobs were opened through the scratch store's signed evidence route
and their hashes verified. Evidence publication to the canonical store remains
unfinished; these links currently resolve only through the scratch instance.

## Contract checks

Three captured-data integration cases verify reopen/rerun idempotency, native
mapping and source timestamps, archived/reply/historical cycle variants, actor
provenance, no owner asks/rollover, and milestone/document sync plus source updates.
The real project had no archived issues, replies or cycles; those variants are
explicit acceptance cases in the integration fixture, not claimed as live proof.
Original authors remain when worker names merely appear in prose.

No webhook mirror, cutover, multi-team mapping or team-wide import ships in this
slice. The command imports one single-team project into a named scratch store.
