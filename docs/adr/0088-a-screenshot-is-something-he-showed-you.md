# ADR 0088: A screenshot is something he showed you

Status: accepted (James, 2026-08-09). Widens the attachable-media boundary drawn
by [ADR 0085](0085-a-picture-he-made-is-something-he-said.md).

## Context

Asked to screenshot a website, Clankie captured one and then said he could not
send it. He was right, and he was following his instructions exactly.

Three things had to line up for a picture to reach a channel, and a screenshot
missed two of them:

- `findGeneratedMedia` harvested only `generate_image` and `generate_video`
  results;
- `CaptainTurnMediaSchema` refined its ref with `isGeneratedMediaRef`, which
  matches `generated/<segment>` and nothing else;
- the only other route, `discord.presence.send_attachment`, is
  `publish-external`, so the invariant floor forces an approval — and no captain
  tool requests it.

So a browser screenshot was structurally unsendable. ADR 0085 said so on
purpose: "Everything else — browser screenshots, repository files — keeps
`send_attachment` and its `publish-external` approval."

The reasoning behind that line does not actually separate the two cases. ADR
0085's argument for auto-attaching generated media is about *provenance*, not
content: only the control plane's generator writes beneath `generated/`, nothing
the captain holds can write there, so a ref under it is provably something a
governed tool produced rather than any file sitting under the attachment root.

Every clause of that is equally true of `browser/`. Only the runner's browser
host writes there. The ref is `sha256:<digest>:browser/<digest>.<ext>` — one
safe segment, hash-bound, re-verified by the resolver for containment and
digest. The captain cannot forge one, cannot traverse out of it, and since
[ADR 0086](0086-clankie-holds-a-shell.md) cannot write anywhere near it.

## Decision

**A screenshot rides his reply, exactly as a picture he drew does.**
`isAttachableTurnMediaRef` accepts a ref under either governed directory, and
`CaptainTurnMediaSchema` and the `reply_with_media` presence write both use it.
`reply_with_media` stays `narrative-write`.

**The harvest reads the result, not the tool name.** `findTurnMedia` no longer
matches an allowlist of tool names; it walks the turn's tool results and offers
each candidate ref to the schema. The generator returns one `artifactRef` at the
top of its result, a browser call returns an `artifacts` array — both are
candidates, and the refine is the authority check. Nothing the model writes is
consulted, so a prompt-injected turn still cannot aim an attachment.

**Everything else keeps its approval.** A repository file, a support bundle, an
evidence archive — anything under the attachment root that neither governed host
minted — is still `send_attachment`, still `publish-external`, still gated.

**The scratchpad moved out from under the attachment root.** ADR 0086 defaulted
it to `$CLANKIE_RUNNER_STATE/scratch`, and the attachment root defaults to
`$CLANKIE_RUNNER_STATE` — so his one writable directory sat *inside* the root
whose write-exclusivity this whole argument rests on. It now defaults beside it
(`captain-scratch`), and the shell host refuses to start if it is ever nested
inside, so the invariant fails loudly instead of quietly.

## Consequences

- What reaches a channel without an approval widens from "pictures he drew" to
  "pictures a governed tool of his produced," which includes any page he can
  render — including pages behind logins his browser profile holds. The
  containment argument is about provenance; it does not constrain subject
  matter. A prompt-injected page that talks him into capturing something
  sensitive now has a one-call path into a room.
- His egress-free shell (ADR 0086) is doing more work than before: he can read
  the whole disk, and a channel attachment is now a lower-friction way out than
  it was. The shell's lack of network remains the thing that keeps read-anything
  from being exfiltrate-anything, and should not be relaxed without revisiting
  this.
- Only the last image of a turn attaches, unchanged from ADR 0085. Three
  screenshots means the one he settled on.
- Two tests that asserted the old boundary were replaced rather than deleted:
  the `browser/` ref that used to prove rejection now proves attachment, and new
  cases pin what still gets rejected — nested paths, traversal, and any
  directory that is not one of the two.
