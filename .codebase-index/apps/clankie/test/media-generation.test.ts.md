# apps/clankie/test/media-generation.test.ts

`ConfiguredMediaGenerator` with an injected
fetch: the two properties that matter are that a
refusal is always a sayable reason (never an
exception) and the returned reference is one the
conversational-attach path accepts.

Images: written under `generated/` with a
sha-bearing artifactRef; refusals for no model
configured and no credential; fallback to the
provider's declared env var; source-ref edits
only accept media it made. Videos: pending
handed back instead of holding the call open,
resume by requestId rather than a second
render, failures turned into sayable reasons.
