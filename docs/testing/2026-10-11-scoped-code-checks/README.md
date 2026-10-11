# File-scoped format and lint beside full jobs

Tracks: https://linear.app/vuhlp/issue/VUH-2102

Oxfmt/Oxlint on up to 64 explicit existing files use the light lane. Direct
binaries, pnpm binary forms and the actual root file-aware scripts are covered.
Directories, globs, missing files, unknown flags, type-aware linting and implicit
repository scans stay full. Root scripts retain their whole-repository/native
checks when no files (or the repository root) are selected. Scoped package
aliases remain opaque. Native tool threads match the permit and keep lower
explicit limits; no admission policy changes in this slice.

The proof uses real Oxfmt and Oxlint, the actual root scripts, native pressure,
private journals and real registered native runner/child processes. No dependency
is mocked. A real full job holds the fixture's only full slot, and its FIFO
follower remains queued throughout all five scoped runs. The selected file is
formatted; an unformatted unselected sibling remains untouched. The fixture's
memory floor remains 4096 MiB. Its load ceiling of 16 allows the initial held
job on this loaded machine; real slot saturation holds the follower.

Checked results:

- Lane/server suite: 13/13 passed. Package typecheck passed.
- Final native-pressure saturated proof: 2/2 passed in 8.65 seconds. The five
  actual commands completed in 0.92–1.69 seconds, with one full permit held and
  one full follower queued after each. Measured load ratio was 2.92–3.41 and
  available memory 31.9–34.0 GiB.
- Oxfmt reported two threads even when 18 were requested. Lower explicit caps
  remain lower. Malformed thread flags are passed through for tool diagnostics.
- Both new cases failed against the original classifier (`full` where `light`
  is required). Fixed source was restored before final verification.
- Focused lint and formatting passed. Direct small-file formatting used the
  lead's temporary exception while the installed classifier still queues it.

Quill confirmed no overlap and the sampled arbitration/progress seam is
preserved. Basil was informed of the classifier and two launch-argument calls.
The exact-tree integrator gate supplies landing verification; no duplicate
local root gate was run. VUH-2103 separately tracks full-lane progress when no
full job is held; this slice does not change overload admission.

Raw logs and checked sources are archived in `evidence.json`.
