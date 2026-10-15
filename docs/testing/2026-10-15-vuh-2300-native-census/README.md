# VUH-2300: fresh cwd protection without repeated lsof scans

Tracks: https://linear.app/vuhlp/issue/VUH-2300

The original forty-tree reclaim case exceeded its unchanged 120-second test
bound, followed by two 30-second teardown timeouts, in VUH-2299's root gate.
Its 34 terminal batches require roughly 68 fresh pre-removal cwd censuses.
Three whole-system `lsof -nP -d cwd -Fpn` scans measured 2.770–2.780 seconds
each, enough to exceed the test deadline before other work completes.

Darwin cleanup now reads the kernel's PID inventories and vnode cwd paths
through the existing private native helper. Each live account process must
have a fresh path bracketed by matching lifetimes. Readable other-user paths
remain included; a second account inventory detects newly born/unobserved
live processes. Exit/inventory churn restarts within the existing bounded
helper budget. Incomplete observations still retain directories. Every removal
still requests a new census, without caching, skipping live-process checks,
raising the original timeout or weakening reclamation assertions. Linux keeps
its existing procfs observer.

The original case passed **10/10** separate invocations: five under normal
fleet work and five alongside an additional four-worker governed CPU load,
bounded to ninety seconds. The loaded series sampled load1 **7.63–10.57 /
18 cores** and CPU **44.3–72.4%**. Related native-census, cache-reclamation and
membership checks passed **54/54**. The retained captures include
census measurements, separate repeated original-case invocations under normal
fleet work and additional governed CPU load, and related native-census,
live-process cache-reclamation and membership checks. The positive native
census test observes two real owned processes, a newline/quote/Unicode path,
`chdir`, and process exit. All owned stress/process fixtures are bounded and
cleaned up.

[Focused captures and source diff](captures.txt) retain commands, measured
conditions and outcomes, including intermediate incomplete-census refusals
before the bounded exit-race retry was corrected. The final repeat counts and
exact-tree landing result are reported on the issue. No eval, installed-runtime
update/restart or release ran.
