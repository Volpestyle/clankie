# ADR 0088: A screenshot is something he shows you

Status: accepted (James, 2026-08-09). Widens the attachable-media boundary drawn
by [ADR 0085](0085-a-picture-he-makes-is-something-he-says.md).

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

**Everything else keeps its approval.** A repository file, a support bundle, an
evidence archive — anything under the attachment root that neither governed host
minted — is still `send_attachment`, still `publish-external`, still gated.

## Consequences

- What reaches a channel without an approval includes pictures his governed
  tools produce, including any page he can
  render — including pages behind logins his browser profile holds. The
  containment argument is about provenance; it does not constrain subject
  matter. A prompt-injected page that talks him into capturing something
  sensitive has a one-call path into a room.
- System tools remain separately governed by actor and lane (ADR 0086); they do
  not assign turn media.
- Only the last image of a turn attaches, unchanged from ADR 0085. Three
  screenshots means the one he settled on.
- Tests prove browser attachment and pin every rejection: nested paths,
  traversal, and any directory outside the governed roots.
