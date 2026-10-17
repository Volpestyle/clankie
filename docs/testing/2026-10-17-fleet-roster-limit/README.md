# VUH-2354: complete fleet rosters and bounded display latency

Issue: https://linear.app/vuhlp/issue/VUH-2354
Decision: [ADR 0135 amendment](../../adr/0135-a-herdr-seat-is-a-conversation.md).

## Live failure

The official contacts CLI captured HTTP 200 with 52 seats against a 48-seat
response schema, failing client validation. The same read explicitly reported
cached observations after a five-second projection timeout. The private original
capture is [retained evidence](clankie://evidence/sha256/419c86e65130318992e085f699d71d751bfa53f85afa61cb4a4541961ca6fee3).

Read-only service timings on deployed c0776ff15 show projections taking 20–24
seconds: about 17 seconds in capability observations, while the native census
takes less than one second. Each Codex capability query performed open-file
discovery even when the census already supplied an exact native thread.

## Repair and proof

The aggregate schema permits 768 seats. Native discovery preserves local seats
beyond 48; a larger complete projection is refused with HTTP 503
`fleet_roster_limit`, including the count and limit. No seats are silently cut
from a successful response. Durable personas retain their separate 1,000 bound.

Display capability observations reuse an exact session ID, or a rollout UUID
with an observed Codex foreground process. Unknown identities keep file
discovery. The current occupant is still rechecked. Sends retain their separate
fresh process, file, recipient and authorization checks. Display deadlines and
stale warnings are unchanged.

The real captain and authenticated loopback HTTP API, with an isolated native
transport fixture, return all 52 seats through both fleet and roster reads,
then the contacts CLI, without stale warnings. The fixture deliberately stalls
file discovery; display reads never invoke it. A 769-seat observation gets the
explicit 503 refusal. A separate native-control integration confirms that a
displayed choice cannot send to a changed native thread and that a rollout path
without a foreground process advertises no delivery modes.

Four focused suites passed all 46 tests. Restoring the old cap and display file
discovery made both corresponding regressions fail. Retaining the larger cap
but restoring only file discovery separately made the 52-seat HTTP read fail
with its five-second stale warning. Fixed producers were restored byte for
byte. The manifest retains those controls, earlier failed fixture/implementation
iterations, the final passing output, source diff and baseline timing records.
The issue records final landing checks and commit.

## Remaining runtime proof

The loopback results establish the public boundary and the identified slow path;
they do not measure the deployed repair. After lead deployment, capture a fresh
normal fleet read without projection warnings and its timing record. Older
clients compiled with the 48-seat schema need the updated protocol contract.
No deployment, shared-service restart, live settings change or PC steering was
performed. VUH-2355 separately tracks KH2's unreachable connection binding.
