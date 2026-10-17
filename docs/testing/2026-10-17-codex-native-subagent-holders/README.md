# Native Codex children get automatic simulator holders, live (VUH-1888)

Tracks: [VUH-1888](https://linear.app/vuhlp/issue/VUH-1888).
This complements the [native Claude proof](../2026-10-17-native-subagent-holders/README.md).

## What ran

- Installed CLI source at the start: `cc2eb50e57c28b89f3979adf68d3965fb8615989`.
  At the grant/queue proof it was `5cfcdc2e9cf22ad43346bed9e235b2de2dbf7774`.
  Both contain holder fix `050aeba51`; CLI version was `clankie 0.4.4`.
- Parent: hired native Codex seat `term_65e0166547b2083`, pane `w55:pD`.
- Two native `spawn_agent` children of that seat; no headless harness.
- Exact existing iPhone 17 Pro: `ECF31A58-614F-40A7-87C9-914A4930D974`.
- Neither child sets identity environment variables or supplies `holderId`.
- Verbatim commands, environment captures and decisive receipts: [`live.txt`](live.txt).
  The complete packet also retains the earlier bounded waits and service interruption.

## Environment inheritance finding

The hired parent seat and both native children directly observed
`CLANKIE_RESOURCE_HOLDER=claude:ad9b73a1-9c79-4688-9daf-4cbc4e9502e6`
in their shell process environment, using Python `os.environ` inside native
`exec_command`. **This was an environment variable, not hook output.** The lead
identified this value as his operator session ID. It was already present in the
hired parent before either child was spawned and propagated unchanged to both.
No environment variable was set, cleared or substituted for this proof.

| Native context | Actual `CODEX_THREAD_ID`               |
| -------------- | -------------------------------------- |
| Hired parent   | `01a14809-e898-7413-b46f-fd393fc19a50` |
| Child A        | `01a1481f-5773-7c42-abfe-1c4184c2d835` |
| Child B        | `01a1481f-6dfb-7bc1-aceb-3beab43dad2d` |

The automatic holder resolver prefers each executing `CODEX_THREAD_ID` over
the inherited value. A's queued receipt already confirms the correct
`codex:01a1481f-5773-7c42-abfe-1c4184c2d835` holder, including after resuming
the same native child. That precedence prevents the inherited operator label
from collapsing Codex leases. The operator-label inheritance into the hired seat
is a separate observed environment leak, tracked in [VUH-2336](https://linear.app/vuhlp/issue/VUH-2336).
Its upstream origin has not been traced or repaired by this proof. Captures were
shared with Kit, who owns that follow-up.

## Result

| Native child       | Automatic holder                             | Acquire                                                                                                                      |
| ------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A                  | `codex:01a1481f-5773-7c42-abfe-1c4184c2d835` | `acquired`, lease `883481a4-ee10-4480-8175-e929fd5bfc42`, exact iPhone 17 Pro booted                                         |
| B, while A held it | `codex:01a1481f-6dfb-7bc1-aceb-3beab43dad2d` | `waiting (simulator_capacity)`, ticket `c43ddd79-4255-418c-8cab-369d62ab5210`, position 2, A's holder/lease named as blocker |

B did not receive A's lease. Its queue position was 2 because Moss already had
an earlier ticket; neither child jumped that request. B cancelled only its own
ticket, and A's lease remained booted until A released it. A's grant was created
at 05:04:06.615Z; its release receipt was captured at 05:05:54.133Z, keeping the
owned window under two minutes. No device was driven and no app was launched,
installed or removed.

## FIFO and cleanup

A initially waited behind the occupied simulator pool. Its original ticket
`85743b98-f2cb-47df-9c7e-d0699ef9734b` and enqueue time `1792211389536`
survived bounded same-ticket resumes. One open wait returned
`service_restarting` / "The simulator manager is stopping." After the service
returned, the same ticket was still present; A resumed it. The installed CLI
source changed during this external interruption. Neither parent nor child
restarted or deployed anything.

Earlier requests finished first. After A's grant, B's separate ticket queued
behind Moss and named A's lease as the current device blocker. Cleanup:

- B's cancellation returned `{"outcome":"cancelled"}`.
- A, resumed with the same native thread, released with no explicit `holderId`:
  `{"outcome":"released"}`.
- The immediate final status returned `leases: []`, `externalActive: 0`.
- Moss was notified immediately so its existing queue request could advance.

The Codex native automatic-holder criterion is now proven live, complementing
the existing Claude proof. No holder-isolation code change or new test was
needed. The remaining environment-leak repair belongs to VUH-2336. Lead owns
issue closure.
