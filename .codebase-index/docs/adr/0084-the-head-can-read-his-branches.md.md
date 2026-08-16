# docs/adr/0084-the-head-can-read-his-branches.md

`observe_room` reads the same bounded append-only
`LaneLog` used by the TUI. With no arguments it
lists visible rooms; with `(lane, targetId)` it
returns recent `heard` and `said` entries — never
private reasoning, tools, or raw pi state.

Visibility is asymmetric and host-derived: the
operator can read every room, while Discord,
voice, and gameplay can read non-operator rooms
but can never list or read the operator lane. A
read never sends, resumes, or steers the target.
