# VUH-2148 import evidence

The historical landing batch `dd8ee0d0-fd33-463d-9241-e14cfe276a50` selected
363 modules. It reported 508.53 seconds summed import time, 623.97 seconds
test wall time, and 947.34 seconds for the complete landing gate. Summed worker
time is not wall time.

We reused those exact 363 paths with Vitest's import-duration instrumentation
and `collectTests`: no tests or hooks execute. Forks, isolation, four workers
and the serial remote project remain unchanged. All four collections completed
with zero module or unhandled import errors, against the original `990a774a`
base plus each successive source patch. Host load varied; instrumentation also
makes these figures incomparable with the historical uninstrumented gate.

| Source state                         | Collection wall, seconds | Summed import, seconds |
| ------------------------------------ | -----------------------: | ---------------------: |
| Baseline                             |                   321.17 |                1184.45 |
| Lazy snapshot only                   |                   320.41 |                1168.31 |
| Image/provider/Pi import seams       |                   246.53 |                 900.53 |
| Protocol/settings import seams added |                   253.76 |                 924.12 |

The final collection was 21.0% lower in wall time and 22.0% lower in summed
import time than baseline. This is an observed result, not a controlled causal
estimate or a passing full gate. The protocol phase did not improve wall time
over the preceding phase under changing load.

## Causes and remaining cost

The baseline's slowest files were Discord bridge room recovery (10.204s), relay
conversation questions (8.266s), conversation tail sharing (8.104s), evidence
fetch (8.095s), and lead roster/device (7.930s). Broad service and settings
graphs repeatedly load dependencies in each isolated file.

- The models.dev JSON contributed 124.78 seconds across 266 files at import.
  It now loads and validates on first catalog use, retaining synchronous API
  and memoization. It is absent from the later import-only graphs.
- Pi AI's root contributed 69.99 seconds across 265 files. After using narrow
  model utilities and removing the voice provider barrel, its final measured
  self time was 5.73 seconds across 235 files.
- Protocol's root contributed 45.16 seconds self time across 357 files. Narrow
  settings imports and direct sibling imports remove broad internal cycles;
  final self time was 27.36 seconds across 355 files. Most service tests still
  import the public root directly. Its browser bundle remains Node-free.
- Pi coding-agent remains in 293 files: 210.37 seconds self time at baseline,
  250.40 seconds in the final run. Lazy image processing removes that eager
  edge, but other captain/session/tool imports still load the SDK. Do not
  attribute its remaining cost to the removed image edge or claim it vanished.

External self time includes that external module's native import subtree.
Inclusive timings overlap and must not be added. These measurements show why
per-file isolation multiplies an eager graph; they do not measure a safe
isolation alternative. No isolation, assertion or timeout was changed.

## Verification

Focused catalog, image, provider and voice contracts: 98 tests passed across
four files (4.38s). All six affected packages passed typecheck. The first
provider typecheck found a missing type import after moving the family helper;
the correction and successful recheck are retained. Explicit touched-file
formatting and lint passed. Real esbuild checks proved the protocol index
bundles for the browser and the bundled lazy catalog loads and memoizes.

The merge queue still supplies the exact-tree landing check. Live gate timing
after the priority update remains a separate acceptance measurement.
Raw collection diagnostics, the exact selection, source patch and check logs
are linked by the evidence manifest and attached to
[VUH-2148](https://linear.app/vuhlp/issue/VUH-2148).
