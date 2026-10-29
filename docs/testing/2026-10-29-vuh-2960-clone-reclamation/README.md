# Integration clone reclamation assertions (VUH-2960)

Two existing release-suite assertions still expected scratch-only reclamation
when VUH-2939 added private clone reclamation. This patch changes tests only.

The same two real integration cases ran in a separate worktree with scratch
HOME, under `clankie heavy`, at three revisions:

| Revision                   | Result   | Observed contract                                        |
| -------------------------- | -------- | -------------------------------------------------------- |
| `17ff7d461` (`8e33bfa34^`) | 2 passed | Scratch-only cleanup                                     |
| `8e33bfa34`                | 2 failed | 2,375,680 bytes instead of zero; 100 paths instead of 67 |
| `1ad9fb1ca`                | 2 failed | Same two assertion failures                              |

The parent-to-commit boundary pins the change on VUH-2939 itself. Its commit and
ADR 0240 intentionally remove pushed clones at the next sweep. Its retained
passing gate contains 621 test modules and excludes this release-only file.
The raw `--changed` selection without `CLANKIE_LANDING_TESTS=1` was initially
mistaken for the landing selection; the issue records the correction.

The revised cases pass 2/2 (93.80 seconds of tests). The ten-landing case checks
the retained ref before the sweep, counts exactly ten reclaimed private clones,
checks freed space and an empty second sweep, and verifies the original log and
record assertions. Its existing restore runs after the clones are gone and
still recovers the requested tree from origin history.

The historical-tree case counts 33 additional disposable private clones. It
keeps every original active/foreign and external-symlink assertion, and adds
foreign and non-terminal clone paths to the protected-path existence checks.
Production reclamation and test deadlines are unchanged.

The evidence manifest links historical red/green runs, the revised focused run,
and the saved VUH-2939 gate selection. Standing review and landing gate are
separate delivery checks; focused verification does not replace them.
