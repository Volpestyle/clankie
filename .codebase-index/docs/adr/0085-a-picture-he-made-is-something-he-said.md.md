# docs/adr/0085-a-picture-he-made-is-something-he-said.md

Wires ADR 0029's dormant media connector into the
product: generation runs centrally (doctrine +
brokered credential; provider/model from operator
config, never the request), and a picture he made
this turn rides his reply as
`reply_with_media` (narrative-write) — no
approval prompt.

Read for the provenance argument that makes that
safe: the generator's only write target is
`generated/` under the attachment root, and
nothing he holds can write there — stated as a
property so a later shell grant (ADR 0086) keeps
it true. The attachment is harvested from the
turn's own tool results, never asserted by the
model. Also: refusals are sentences he can relay;
connector schema v2 adds async video jobs
(bounded 90s wait, resumable by request id,
SSRF-guarded download). Widened by ADR 0088
(screenshots).
