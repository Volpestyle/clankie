---
name: lead-skin-tools
description: Compile, sample or mechanically check a lead avatar with Clankie's installed deterministic skin tools. Use when preparing native-grid avatar data or checking a lead pack. This skill does not generate images or publish a look.
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
