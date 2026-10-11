# Owner pose-approval boundary

Tracks: [VUH-2114](https://linear.app/vuhlp/issue/VUH-2114).

This is the no-spend increment: a durable owner brief, committed owner inputs,
native rest/work/comms poses and exact-revision owner approval. It neither
requests generation nor changes appearance. Source, API/CLI and agent guidance:
[owner key-pose drafts](../../skin-drafts.md).

## Proof

The real owner credential store, service HTTP adapter, committed attachment store,
deterministic compiler and bundled release CLI prove create → three 32×64 native
poses → preview → approval → history/list, without changing the settings snapshot.
The unrelated captain fixture does not run a model/provider. A rotated credential
refuses the old CLI bearer. Additional integration cases cover revisions and
rest replacement clearing approval, stale/foreign approvals, forged direct tool
approval, revocation between staging and commit, restart, retained owned source
bytes after attachment deletion, idempotent create, cancellation, empty/mismatched
poses, unowned worker delivery and changed bytes blocking approval.

- Focused integration/compiler suites: **9 passed**, 2 files, 7.69 s.
- Final service source program: **passed**, 436 roots, 11.03 s, 1,979.4 MiB compiler heap.
- Final affected test program and its imports: **passed**, 21.41 s, peak 2,095.6 MiB.
- TUI typecheck: **passed**, 42.79 s, peak 2,148.1 MiB.
- Protocol typecheck: **passed**, 1.68 s, 475.7 MiB.
- Compiler ceiling stayed at **2,560 MiB** (2,512 MiB old space).

Earlier package checks caught fixture call-signature and optional-field errors;
those were corrected before the final source and affected-test checks. The full
package check was not claimed green. The integrator owns the root landing gate.

`native-rest.png` is the inspected native API output: a mathematical red sentinel
column on a transparent 32×64 grid. `draft.json` records its actual API/CLI approval
and three matching native digests. This is diagnostic data, **not avatar art or a
visual-approval claim**. No private image, licensed/reference palette, product
skin registry ID or real account identifier was copied into public source.

## Gaps

Sentence-to-generated references/poses, provider admission and media receipts
remain pending the parent's credit decision. Classic comparison/review UI,
animation, independent visual review, catalog and live selection belong to the
later children. No hosted deployment, live hosted/device proof, generation spend,
eval or full local root gate was performed.
