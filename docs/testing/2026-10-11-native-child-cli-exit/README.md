# Native child CLI exit diagnostics

Tracks: https://linear.app/vuhlp/issue/VUH-2103

Combined batch `8c4539be-2135-402a-8d38-a51ffa63bfdb` failed its core gate at
`fleet-resources-cli.integration.test.ts:787`: the first owned native-child
heavy CLI exited 1 instead of 0 after its command was released. Its captured
output was omitted from the assertion, so the actual CLI/native error is not
available in the gate log. The change adds that output to both exit assertions;
expected exit 0 and every holder, queue and permit assertion stay intact.

The failed core tree was `6d8cb45be1486e8904c56cd24e2c57fc5ec16dbc`, based on
main `533c681d8`. VUH-2098 was present; VUH-2102 and VUH-2103 were absent.
The fixture supplies calm pressure to both the service governor and native
headless clients, so admission's load guard is not the direct failure. A native
helper failure under load remains possible, but no such cause was observed.

Checked through `clankie heavy`, without a duplicate root gate:

- The unchanged exact failing case on its original core tree passed: one
  case, 12 skipped, 3.90 seconds. It ran in an owned copy with independent
  dependencies and the same lockfile.
- The same unchanged case before VUH-2098, at `bd19adeee8dd3be5de01bdc861a49657a41e46e7`,
  passed: one case, 12 skipped, 5.60 seconds.
- With the diagnostic assertion messages on main `533c681d8` plus the pending
  VUH-2103 policy, the full CLI suite passed all 13 cases in 30.81 seconds.
  TUI typecheck passed. No runtime behavior or test timeout changed.

These passes do not prove the original failure was a load flake or rule out a
VUH-2098 interaction. The failed batch's original whole-machine pressure sample
and child stderr are unavailable. The native diff in VUH-2098 affects only the
server CPU path; the full-command wait path was unchanged. That is source
inspection, not a proof of absence of every possible interaction.

An initial exact-tree run failed before tests because copied integration
dependencies pointed at its absent sibling app store. An initial broader
follow-up also lacked TUI dependencies. Both setup failures are retained. The
owned copies were then completed from an independently installed worktree with
an identical lockfile, without dependency links to another checkout.

The nonzero **Full-gate result**, **Isolated passes**, setup errors and checked
diagnostic source are archived in `evidence.json`. The original exit-1 cause
remains open. A future recurrence will now include the captured native cause.
