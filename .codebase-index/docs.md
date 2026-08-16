# docs

The repo's documentation: one architecture
overview, 58 active decision records, and rendered
diagram assets. Read `architecture.md` first; it
maps Clankie's one-service body, its surfaces, and
the current message, tool, memory, game, auth, and
herdr flows.

## Children

- `architecture.md` — top-level system map: one
  service (`apps/clankie`) plus surfaces, the
  message→turn flow, tools, auth, and constraints.
- `adr/` — 58 numbered architecture decision
  records (0012–0099, with deliberate gaps and
  two distinct 0098 records).
- `diagrams/` — binary JPG renders plus the
  compressed tldraw source board; assets are not
  indexed as text files.

## Notes

ADR numbering is intentionally non-contiguous. The
active set describes the current Pi service,
launcher, Discord bodies, game hosts, and their
security and lifecycle boundaries; historical
option context stays inside the decisions it
supports.
