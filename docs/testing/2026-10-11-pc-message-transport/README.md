# VUH-2135: finite SSH transport and definite failed-send receipts

Original native proof source: `77a2942602d5e4c15f06a64205698c1db329bb5f` (base `447a0ea56388255ca002bcb8d71d505823df8fe7`).

Replacement source: `4e71fefe9e43aa8b04367b3a1d78ceeb2bd69f2a`, rebased on
`4dd34fff28344aa7037bbf2f6f19ef53071cd288`. The original integration request
`96a722b7-c7ff-44f2-a6bf-7865f6bd53ea` failed in batch `701e73e5` because
the optional delivery verdict was assigned `undefined`. The replacement omits
the property when absent, preserving `exactOptionalPropertyTypes`. The full
workspace check also caught a missing `command` declaration in the new SSH
fixture record type; that declaration is corrected.

Large finite Windows wrappers now travel as one base64 line over SSH stdin;
POSIX uses `sh -s`. The SSH control request stays below 4,096 bytes. A per-command
remote-entry nonce prevents child stderr that resembles an SSH failure from
being treated as not-sent. Proven mux rejection or bootstrap launch failure
returns undelivered and releases only its exact dispatch fence; resets and lost
native acknowledgments remain uncertain. Windows' login shell may map the
bootstrap exit 127 to 1; the unique launch marker still proves no child started.

## Checks

- Formatter and lint passed on explicit touched files.
- Five focused test files: **80 passed, 1 skipped**. The skipped test is the
  unchanged VUH-2143 opt-in native catalog proof.
- Real PC (`volpe@supedupsilly`) read-only proof: three 32,768-character Unicode
  hash round trips and a 20,000-character Node argv round trip, through the same
  owned multiplexed SSH master. A nonexistent-cwd bootstrap returns not-sent.
  Only this proof's own SSH master was closed.
- Native child-process fixture proves a pre-channel rejection launches no remote
  program and allows a deliberate follow-up across a receipt-store restart.
  A dispatched child printing `mm_send_fd` keeps an uncertain receipt.
- Replacement: root `pnpm typecheck` passed, **32/32 tasks**, including
  discord-bridge and all service test partitions. Formatter/lint passed;
  focused transport/receipt consumers passed **54/54**. The preceding
  nonzero workspace check is retained beside the passing rerun.
- Integrator supplies the required exact-tree root landing gate.

## Historical acceptance gaps (updated 2026-10-26)

This is the transport/receipt slice, not completed VUH-2135 acceptance. No real PC
worker seat received a brief; existing KH2 panes were untouched. After landing
and deployment, the lead will send one 20,480-byte inert test to review3
(`pc/term_65d5c260e9af62e`). The worker bridge lacks `message_seat`.

A separate real-PC probe confirmed a full 32,768-character child argument fails
Windows `Process.Start` with “The filename or extension is too long”, after SSH
succeeds. It now reports definitive not-sent. Full-size standalone CLI delivery
still needs a staged payload pointer or native input route; a shell hash proof
does not establish `message_seat` native acceptance.

The raw logs, boundary probe and tested source provenance are in the evidence
archive manifest beside this README.

The Windows argv gap above was subsequently addressed by VUH-2258
(`2d2d558fd`, `1718f70f1`), which stages full-size standalone queue bodies and
sends a SHA-256 pointer. The [current verification and cleanup follow-up](../2026-10-26-vuh-2135/README.md)
records the refreshed PC proof and live-seat acceptance; the original results
above describe the October 11 slice.
