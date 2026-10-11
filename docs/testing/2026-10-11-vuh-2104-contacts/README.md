# VUH-2104: bounded contacts reads

Tracks: https://linear.app/vuhlp/issue/VUH-2104

Fresh worktree `/Users/james/dev/clankie-wt/vuh-2104`, based on fetched
`origin/main`, rebased without conflicts onto `cf61cc10a9b0af7558b84d6b9bc40c8a7d137269`.
The source checkout was not edited.

## Cause and result

`agents contacts` reads the full fleet snapshot. Its old consistency loop had
no retry limit: changes to the Herdr cursor during each slow observation restarted
the whole read. Remote Herdr already has a 20-second command deadline; named
local Herdr has a 15-second deadline and the default census runner has five
seconds. Those command deadlines did not bound the repeated full handler.
The command's fetch also had no explicit deadline, explaining the roughly
five-minute client failure. The historical production request was not
instrumented, so no individual remote machine is claimed as its cause.

Fleet display reads now retry once and have a five-second observation budget.
A busy view returns `fleet_consistency` / `changed_during_read`. A stalled
census names each pending `herdr:FLEET_ID`; other pending phases name
`native_fleet_projection` or `checkout_observations`. `readWarnings` explicitly
labels retained data as incomplete. The pre-read cursor is kept for the next poll.
Only one shared native refresh remains in flight; it is not restarted or treated
as mutation admission proof. Native command deadlines and admission reads remain.

Contacts keeps its array result on complete reads; partial replies are
`{ personas, readWarnings }`. Rename and role lookups refuse incomplete reads.
The CLI's HTTP transport has a twelve-second deadline.

## Evidence

- The slow-census / continuing-change regression fails against the old handler
  at `cdd373ca`: no reply before its observation window. The same test passes
  with the fix after exactly two census reads.
- A held census returns a partial HTTP/CLI result after five seconds, names
  `herdr:default`, preserves the previous seat and known contact, and concurrent
  readers share one census. Releasing the dependency restores complete replies.
- Both regressions exercise the production captain and Hono dispatch over real
  loopback HTTP, through the production protocol decoder and CLI. Only the
  native census dependency is deliberately held/changed; no test clocks replace time.
- Final focused check: **251 tests passed in 11 suites**, including census,
  persona, fleet lead-round, TUI command, TUI conversation, relay and home projection
  consumers. Both Clankie and TUI typechecks passed. Direct formatting passed on
  every touched file. No local full root gate or eval ran.
- A read-only probe using the new CLI against the existing service timed out in
  **12,008 ms**, with `TimeoutError`, verifying the client cap; it does not prove
  deployment or a successful live partial reply.
- `evidence.json` links the retained logs, native fixture and full patch.

## Remaining verification

Land and deploy, then rerun `clankie agents contacts` against the live service.
The delayed fixture proves the server deadline and partial contract; the live
pre-deployment failure proves only the client bound. Lead owns closure.
