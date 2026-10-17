---
name: lead-skin-tools
description: Prepare owner key-pose drafts, compile, sample or mechanically check a lead avatar with Clankie's installed deterministic skin tools. Use when preparing native-grid avatar data or checking a lead pack. This skill does not generate images or publish a look.
---

# Prepare a lead skin

Use the installed `clankie skin` commands and the shared
[contract and compiler](../../../packages/lead-skin/README.md).

1. Sample a supplied reference with `clankie skin sample IMAGE OPTIONS.json
--out NEW_DIRECTORY`. Inspect `native.png` and the reported grid. An estimated
   pitch is a proposal; correct it using explicit pitch, origin and grid size.
   Keep the character's native proportions. Never squash it into a shorter cell.
2. Show the base and key poses beside their references. **Wait for owner pose
   approval before animating.** Reuse the approved palette for subsequent poses;
   sampling or compilation never counts as that approval.
3. Compile the approved source grids with `clankie skin compile SOURCE
--out NEW_DIRECTORY`. The output is JSON, immutable PNG data and paginated
   review sheets, without executable packages or client registration edits.
4. Run `clankie skin check DIRECTORY`. Inspect every review sheet with the row,
   frame and timing metadata in `artifact.json`; complete independent visual
   review and refinement before publishing a new skin.

Builds and checks on a shared fleet machine use `clankie heavy --`. Compilation
makes no provider request or live setting change. Local hash consistency is not
catalog authorization. Downloaded artifacts must be checked against hashes from
an authorized catalog using `verifyLeadSkinArtifact`.

Keep private art, references and reference-derived palettes in their authorized
private location. This package ships only generic contracts and deterministic
tooling. Image generation, spend limits, catalog publication and applying the
live look require their own authorized flow.

# Durable owner pose approval

Use `clankie skin draft` or the operator-lane `skin_draft` tool to prepare a
brief and already-owned rest/work/comms poses. The [draft contract](../../../docs/skin-drafts.md)
names the commands and exact-revision image preview routes. Commit each image
through the owner's conversation attachment API, sample rest first with an
explicit native grid, then keep its geometry and palette for work/comms.
Show source/native poses side by side with Classic before asking the owner to
approve the returned revision through the owner API or CLI. Agents cannot
approve or decline through `skin_draft`; no model argument supplies authority.

Any brief or pose edit clears approval; replacing rest also clears work/comms.
Read current state after a conflict or lost reply. Reuse create's request UUID
only for the same intent; never automatically replay uncertain edits.
Cancellation is terminal. Owner approval binds exact source/native bytes and
three native digests; it does not authorize animation generation, spending,
independent visual review, publication or changing the live look. Those later
stages must verify the exact approved revision again.

`clankie skin draft generate ID REVISION --request UUID` and tool action
`generate` join the configured media seam to the same draft journal, but paid
generation currently refuses until the owner credit-admission policy exists.
No request argument opens that gate. Never substitute another media tool to
evade the admission refusal. Reconcile a lost reply by reading the draft and
retaining the original UUID/input revision. An uncertain journal is not a failed
charge and must never be retried with a fresh UUID. Completed media receipts,
including upstream request IDs where available, survive restart. The private
app can review/edit these exact poses; approving them remains the owner's act.
