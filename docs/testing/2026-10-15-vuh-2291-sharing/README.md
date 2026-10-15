# VUH-2291: gates share build capacity

Tracks: https://linear.app/vuhlp/issue/VUH-2291

Integration gates use ordinary full-lane FIFO admission and one slot. Other
full builds, light work and simulator reservations/boot submissions use their
normal resource guards. The core failed-file retry pass has one five-minute
deadline; timeout kills Vitest, records a failed rerun, and blocks recovery.
Direct landing is the default in the CLI and shipped worker guidance (ADR 0240).

## Verification

- Governed native governor and real Vitest checks: **9/9 passed**, 12.49 seconds.
  Arbiter and fallback cases ran real process births, native runners, OS locks
  and journals with controlled pressure observations in a private registry.
  A full build and light command ran while a gate held a slot; later builds
  retained FIFO order ahead of later gates. Cancellation preserved the memory
  floor. Simulator journal updates used no native device or boot.
- Real Vitest recovery left the overlapping passing file untouched and reran
  each failed file once. A rerun hanging for 60 seconds hit a shortened
  three-second acceptance deadline, returned SIGKILL/failure, and left the
  next failed file unexecuted. The shipped deadline is five minutes for the
  entire retry pass, including runner startup.
- Real production-config Vitest collection with the serial integration file
  selected listed only `apps/clankie/test/integrate.integration.test.ts`.
- The final portable two-slot native proof passed **3/3** in 5.81 seconds,
  with controlled CPU observations and no simulated startup charge.
- Fleet-resources typecheck and lint of all seven touched code files passed.
- The source CLI's `integrate --help` printed direct landing and ADR 0240.
  It exited 1 through the existing invalid-option usage path; this is an
  inspected usage capture, not a successful integration submission.

[Source diff and focused command captures](captures.txt) retain the evidence.
The root landing gate's checked HEAD, fixed base, exit and uploaded logs are
reported on the issue after landing. No evals or installed-service restart ran.
This is source/native-runner proof; the live installed service and clients
must update before the shared scheduling policy takes effect.
