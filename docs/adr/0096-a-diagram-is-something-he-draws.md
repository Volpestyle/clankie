# ADR 0096: A diagram is something he draws

Status: accepted (James, 2026-08-15). Extends the attachable-media boundary of
[ADR 0085](0085-a-picture-he-makes-is-something-he-says.md) and
[ADR 0088](0088-a-screenshot-is-something-he-shows-you.md) to a third governed
host.

## Context

He can draw a picture and he can show you a screenshot. Asked to explain a data
model or a protocol, he can only write prose — and the thing that actually
builds a shared mental model is a diagram.

The tldraw desktop app already runs on the operator's Mac and exposes a local
HTTP server that can execute JavaScript against a live editor. The
`tldraw-design-systems` skill already carries a design language for exactly this
kind of picture: an entity table shape, a sequence shape, a theme. A human
driving that skill through a shell gets good diagrams.

Handing him the same shell does not work, for two separate reasons:

- **Only some lanes hold a shell.** Coding builtins attach to the operator
  console and to Discord text turns whose actor is on `systemActorUserIds`
  (ADR 0095). Voice never has them, and neither does anyone who is not the
  owner. A capability that only exists on the owner's text turns is not a
  capability he has.
- **A shell plus untrusted text is the thing we do not build.** Channel content
  is untrusted input. `POST /api/doc/:id/exec` runs arbitrary JavaScript in the
  app's renderer, so a route from a Discord message to that endpoint is a route
  from a stranger's sentence to code execution.

There is also the attachment problem ADR 0088 already named: bytes on disk are
not something he can put in a channel. `turn.media` carries a reply's picture,
and it only accepts refs under a directory a governed host owns. A file he writes
with a shell is deliberately not one.

## Decision

**A diagram is content he describes, not code he writes.** Two tools —
`draw_er_diagram` and `draw_sequence_diagram` — take the picture's _substance_:
entities with their fields and key roles, participants with the messages between
them. The host holds every line of script that reaches the canvas. Request data
crosses into that script double-encoded, as a JSON string the snippet parses, so
no contrivance in a table name can leave its string literal.

That is what lets these tools sit on **every** lane. The boundary is the tool's
shape, not the caller's identity, so voice and non-owner Discord turns get the
same drawing hand the console does. A prompt-injected turn can make him draw
something wrong; it cannot make him run something.

**The diagram host is a third governed writer.** It writes only beneath
`tldraw/` under the attachment root, `isTldrawArtifactRef` matches one safe
hash-bound segment there, and `isAttachableTurnMediaRef` accepts it. Every
clause of ADR 0085's provenance argument holds: nothing he holds can write
there, the ref cannot be forged or traversed out of, and the resolver still
re-verifies containment and digest.

**The look is an operator choice, the content is his.** Exactly the split
ADR 0085 defines for image models: he picks what to draw, the operator picks what
it comes out looking like. `CLANKIE_TLDRAW_DESIGN_SYSTEM` names the active
design system and `CLANKIE_TLDRAW_DESIGN_SYSTEM_DIR` says where the systems
live, defaulting to the `tldraw-design-systems` skill. The host rewrites only
the `ACTIVE` line as it copies `systems.js` into the board, so that file stays
the single place a look is defined and adding one is a skill edit rather than a
service change. The result reports which system it came out in, so he can name
the look without being able to choose it.

**Not being able to draw is a sentence, not an outage.** The canvas is a GUI app
on someone's desk. When it is not open, the tools refuse with
`canvas_unavailable` and a detail that names the fix, the way a missing image
model does. Nothing reaches the app at boot; the first diagram opens the board.

## Switches

| Variable                           | Default                                             | Meaning                                         |
| ---------------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| `CLANKIE_TLDRAW_ENABLED`           | on                                                  | Only an explicit falsey value removes the tools |
| `CLANKIE_TLDRAW_DESIGN_SYSTEM`     | whatever `systems.js` names                         | Which look he draws in                          |
| `CLANKIE_TLDRAW_DESIGN_SYSTEM_DIR` | `~/dev/skills/app-dev/tldraw-design-systems/assets` | Where the systems live                          |

## Consequences

- He draws in Discord, in voice, and on the console, and the picture rides the
  same provenance-scoped reply capture as a generated image or screenshot.
- The capability is bound to a desktop app on one machine. If the service ever
  runs headless, diagrams stop working and say so. That is a real ceiling and
  the price of reusing a tool that is already good.
- The service depends on the design-system skill's checkout. That is a
  deliberate coupling — the skill is the source of truth for the visual
  language, and vendoring a copy would fork it. A missing checkout is a
  refusal, not a crash.
- The shapes he can draw are the ones the design system has. A new kind of
  diagram is a new shape in the skill plus a builder here, not something he can
  improvise — which is the same trade every governed host makes.
