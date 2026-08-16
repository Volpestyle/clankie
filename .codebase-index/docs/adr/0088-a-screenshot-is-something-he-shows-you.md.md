# docs/adr/0088-a-screenshot-is-something-he-shows-you.md

Browser screenshots join ADR 0085's turn-media
boundary and ride the reply on the same governed-
writer provenance argument. The host harvests
validated artifact refs from tool results rather
than trusting tool names or model text.

Only the browser host writes `browser/`, refs are
hash-bound and containment is rechecked, and the
shell scratchpad lives outside the attachment
root. Arbitrary files remain approval-gated.
