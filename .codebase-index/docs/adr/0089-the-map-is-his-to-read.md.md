# docs/adr/0089-the-map-is-his-to-read.md

The player sees the grid the pathfinder walks:
overworld observations carry a `minimap` crop of
the collision grid (`@`/`.`/`#`/`D`, with
`topLeft` for coordinate math) — information,
never advice. Extends ADR 0058 and lifts its warp
deferral.

Read for: classified `walk_to` refusals that name
the map bounds or the nearest reachable open tile
instead of a bare no; the `gMapHeader` decode
(warp events and edge connections, verified
against ground truth on three maps, fail-closed
to absence); and the doorway rule — a `walk_to`
aimed at a decoded warp on blocking collision
walks beside it and presses in, while mid-route
warps still end a route. Pinned to FireRed US
v1.0 like the rest of the profile.
