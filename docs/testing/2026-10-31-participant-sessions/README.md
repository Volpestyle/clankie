# Participant character session evidence

The installed pstack statechart skill 0.15.36 checked these models with its
pinned TLC 1.7.4. Pele 1.9.0 rendered [the character chart](chart.svg), whose
[Mermaid text](chart.mmd) remains editable.

- [Participant model](Participant.tla): 51 states, 115 steps; no duplicate
  character, history reuse, owner-approved machine work, no reply after
  revocation, and deadlock checking pass. The drawing hides terminal
  stuttering and machine work that stays in the same labeled state.
- [Routing design](Clankie.tla): 1,420 states; all six invariants plus deadlock
  checking pass ([report](routing-report.md)). The drawing-only config bounds
  simultaneous owner executors to one, giving 420 states; the full check has
  no such bound. Availability changes and resets are hidden by its view.

These are finite design models, not proofs of the native harness or of all
routing code. The participant model bounds the conversation to two turns and
abstracts process identity, auth, network timing, attachment formats, permission
UI internals, and multiple rooms. The routing model abstracts delivery receipts
and the implementation of each executor. No rule violations were found in
these runs; there are no bug paths to replay from the final models.

Production-boundary integration checks exercise the real captain, launch planner,
settings API/schema, launch journal, native census parser, channel outbox and MCP
transport. The native process and model responses are fixtures. Checks cover:
automatic creation, reuse across speakers, service restart, cold resume of the
same UUID in a new pane, uncertain launch reconciliation, replaced occupants,
configuration revocation before reply publication, reply-only MCP denial,
owner resume-record preservation and old-client setting preservation. Existing
real Pi-loop tests also cover automatic participant loops without the rollout
switch. No live Discord or real Claude permission-prompt claim is made.

Reproduce outside the repository, using the installed pstack skill directory:

```sh
chart_scratch="$(mktemp -d)"
cp docs/testing/2026-10-31-participant-sessions/*.tla "$chart_scratch/"
cp docs/testing/2026-10-31-participant-sessions/*.cfg "$chart_scratch/"
cp docs/testing/2026-10-31-participant-sessions/*.mjs "$chart_scratch/"
cp docs/testing/2026-10-31-participant-sessions/theme.css "$chart_scratch/"
cd "$chart_scratch"
# Set TLA2TOOLS to TLC 1.7.4 and JAVA to Java 11+ if mise does not supply them.
# Run each through clankie heavy -- in this repository's fleet.
<installed-pstack-skill>/scripts/statechart Participant.tla --view participant-view.mjs --out participant-new
<installed-pstack-skill>/scripts/statechart Clankie.tla --view view.mjs --out routing-full-new
<installed-pstack-skill>/scripts/statechart Clankie.tla --config Clankie-drawing.cfg --view view.mjs --out routing-drawing-new
```

The full routing graph exceeds pstack's 500-state drawing budget; its report
still checks every invariant. Use the drawing config only for visualization.

Render with Pele 1.9.0 installed outside the repository:

```sh
node render.mjs /absolute/path/to/pele/dist/pele.js participant-new/chart.mmd theme.css
```
