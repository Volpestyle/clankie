# VUH-2132: disk admission and warnings

Tracks: https://linear.app/vuhlp/issue/VUH-2132

Real native filesystem/process proof on the Mac, 2026-10-11:

- `disk-proof.log`: real `statfs` reported approximately 468 GiB free of 3722 GiB. Raising the isolated registry's floor above actual free space held full, light and server jobs. No child marker appeared. Lowering the floor let a real child write its marker.
- `focused.log`: 34 consumer tests passed, including the new low-disk doctor rendering and periodic lead round from a real resource runtime. Its disk fixture timed out because its synthetic command named `test.ts`, which does not select the light lane. The corrected `disk.test.ts` command passed separately in `disk-proof.log`; this failed run remains retained.
- Earlier focused run: 65 existing checks passed across full-progress admission, CLI/settings/doctor, resource routes, service isolation and project defaults.
- Resource package typecheck passed (`.local/typechecks/run-Ag5srD/report.json`).

Defaults: warning below either 200 GiB or 10% free; new heavy jobs held below 20 GiB. Every lane uses the same owner policy. Existing jobs continue. Disk sampling failure refuses admission. Settings use the existing revision-guarded API and TUI/CLI routes.

## Gaps

This proves the filesystem and local admission boundaries, not a production ENOSPC event. No disk was filled, Docker reset, or existing process stopped. The installed service still needs the landed source to be activated by the lead's normal runtime update.
