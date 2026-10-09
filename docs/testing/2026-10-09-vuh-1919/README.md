# VUH-1919: evidence bundles, owner asks and run gates

The tracker refuses completion past landed without the current item bundle and
an independent check. Its worker cannot check their own bundle. Gates block
runs immediately and reuse ADR 0245 asks; the authenticated owner answer records
the approval. Owner/lead steer, pause and stop are run events.

## Proof

[Scratch service capture](clankie://evidence/sha256/637012934b34d671857eb0f2c7f4ebccc97ebadde17f7bddf240a84608980739)
contains the real replies and durable tracker journal.

- Four focused package typechecks passed: protocol, work-items, clankie and TUI.
- Five integration files passed: tracker evidence/gates, events, runs, cycles
  and releases. They use the real local tracker, SQLite/disk evidence store,
  HTTP owner routes, worker MCP and ADR 0245 conversation store. The new test
  also stops the tracker loop before the owner approves, then restarts it and
  verifies that the retained answer unblocks the run.
- One isolated scratch service ran on a real loopback HTTP socket. A worker MCP
  request created the item and run; HTTP upload and signed blob PUT created a
  real store record; the worker attached its record ID/hash/link in a bundle.
  Missing-bundle and self-check attempts were refused. The owner CLI read and
  checked the bundle, then the worker advanced the item to delivered. A merge
  gate blocked run completion until `input_answer` chose Approve. Lead steer
  and owner CLI pause/stop produced their actor-attributed events. The capture
  includes the actual tracker journal, replies, references and refusal strings.

The scratch record was `7c2e2f60-8141-46a1-9300-e9bea76a74f2`, sha256
`cd9d6050e30b80f13f7c770648338bb3f3e2197feb850259ab5a09bdb5899c0b`.
It belongs to the isolated scratch store; the durable proof is the uploaded
capture listed in `evidence.json`, not a claim that this scratch record exists
in the operator's live store. The scratch mailbox approval used an isolated test
owner identity and authorized only the scratch run.

## Scope and gaps

No deployment, release, eval or native worker process control was performed.
Run controls change tracked execution state and record instructions; they do not
claim terminal delivery or process termination. Gaps are listed for the checker
to judge; the tracker does not infer their severity. Item completion uses its
item bundle, while each run can carry its own attempt bundle. Other tracker
backends explicitly refuse these built-in additions.

The ADR 0226 amendment remains proposed. The landing gate and commit are reported
on [VUH-1919](https://linear.app/vuhlp/issue/VUH-1919).
