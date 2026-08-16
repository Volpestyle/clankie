# docs/adr/0085-a-picture-he-makes-is-something-he-says.md

Media generation runs in the Clankie service with
brokered credentials and operator-selected models;
a successful governed generation in the current
turn is captured and rides the reply without an
approval prompt. Arbitrary files still use
`send_attachment` and its publish approval.

Read for the structural provenance argument:
only the generator writes `generated/`, the model
cannot assert an attachment ref, and the last
successful generation wins. Schema v2 adds
asynchronous video jobs with a 90-second bounded
wait, resumable request ids, and guarded download.
