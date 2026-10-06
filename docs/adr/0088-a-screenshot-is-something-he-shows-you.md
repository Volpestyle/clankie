# ADR 0088: A screenshot is something he shows you

Status: accepted (James, 2026-08-09). Widens the attachable-media boundary drawn
by [ADR 0085](0085-a-picture-he-makes-is-something-he-says.md). The arbitrary-file
approval path cited at ratification was later removed; governed turn capture
remains the current boundary.

## Context

Browser screenshots use the same host-owned turn-media capture as generated
media. A screenshot reaches a reply only when the service browser host returns a
hash-bound reference under `browser/` and the captain tool wrapper accepts it.

ADR 0085's argument for auto-attaching generated media is about _provenance_,
not content. The same capture boundary applies to `browser/`.

Every clause of that is equally true of `browser/`. Only the service's browser
host writes there. The ref is `sha256:<digest>:browser/<digest>.<ext>` — one
safe segment, hash-bound, re-verified by the resolver for containment and
digest. Model text cannot forge one, traverse out of it, or assign it to the
turn capture.

## Decision

**A screenshot rides his reply, exactly as a picture he draws does.**
`isAttachableTurnMediaRef` accepts refs from the generated, browser, and tldraw
governed directories. `CaptainTurnMediaSchema` and the `reply_with_media`
presence write use it.
`reply_with_media` stays `narrative-write`.

**The capture reads the governed result, not model text.** Browser calls offer
their artifact refs to `isAttachableTurnMediaRef`; an accepted ref becomes the
turn's media. Nothing the model writes is consulted.

**Everything else stays outside turn media.** A repository file, support bundle,
or evidence archive that no governed host minted cannot enter the reply capture.

## Consequences

- What reaches a channel through turn capture includes pictures his governed
  tools produce, including any page he can
  render — including pages behind logins his browser profile holds. The
  containment argument is about provenance; it does not constrain subject
  matter. A prompt-injected page that talks him into capturing something
  sensitive has a one-call path into a room.
- System tools remain separately governed by actor and lane
  ([ADR 0086](0086-clankie-holds-a-shell.md)); they do not assign turn media.
- Only the last image of a turn attaches, unchanged from ADR 0085. Three
  screenshots means the one he settled on.
- Tests prove browser attachment and pin every rejection: nested paths,
  traversal, and any directory outside the governed roots.

## Amendment: a file he delivers in a room is something he hands over (James, 2026-10-06)

`deliver_file` in a Discord room turn produced a `delivered/` reference that
the settled-result schema refused. The whole turn then failed as
`captain_session_failed`, nothing was posted, and the bridge resubmitted the
message every minute (two #house-hunting questions, about 200 times each).
James decided that a file Clankie delivers in a room rides that room's reply
without a per-file approval: "it just works".

- `isAttachableTurnMediaRef` also accepts
  `sha256:<digest>:delivered/<conversation key>/<artifact id>/content`, exactly
  the shape the delivered-file host mints. Nested paths, `meta.json` and
  model-written names are refused.
- Unlike the generated, browser, tldraw and share hosts, he chooses the
  delivered file's content. The boundary is therefore the room, not only the
  directory. The service attaches a delivered file only when its conversation
  key is the key of the room the turn is answering, and only from that turn's
  capture (reset at every turn). The resolver still verifies containment and
  digest. Any other artifact keeps `send_attachment` and its approval.
- Media never costs him the reply. A media ref the schema refuses or that
  belongs to another room is dropped, and the words post with a short note.
- A settled failed turn is final. The bridge stores it, stops resubmitting,
  and a directly asked message gets one failure reply under the same
  per-message reply key. The service alerts the owner once when it settles. A
  turn begun by a service process that has since exited, or (for receipts from
  before this amendment) a message more than six hours old, is settled as
  `captain_turn_interrupted` instead of answering 502 forever. It is never
  replayed, because its run may already have had effects.
