# Simulator leases

Detail behind [the skill's](../SKILL.md) lease rules.

## Authority and holders

Use the owner-authorized CLI from an existing proven local native seat; the host
observes the seat's occupant and process identities. Acquire and plan require a
stable task holder: a missing native hook refuses instead of borrowing a
seat-level lease. Explicit owner calls outside a native harness supply their own
`holderId`. Older holderless leases remain releasable through their original
root identity.

Native Claude Bash hooks supply a session/subagent holder; Codex uses its
executing thread ID even when a parent holder is inherited. The Claude hook runs
only for a Bash command that names `clankie` as a command word, so write
`clankie heavy` or `clankie simulator` in the command itself; a script that calls
them internally gets no Claude holder and is refused unless it passes
`--holder`/`holderId`. Other harnesses supply a stable `holderId` in every
simulator request (including touch/release) and `--holder ID` for heavy commands.
`CLANKIE_RESOURCE_HOLDER` alone is ignored, so a stale inherited label cannot
select a lead's lease. New hired panes and dedicated harness servers clear these
fields until their own harness supplies invocation metadata. An explicit holder
overrides the automatic choice for an owned task. Labels never grant seat
authority, and a child cannot touch or release a sibling holder's lease.
`clankie doctor` detects an installed worker plugin without the resource Bash
hook; refresh that profile with the approved harness setup route. A new hook
does not update a session that has cached hook definitions.

## Queue

Acquire takes one persisted FIFO ticket and blocks on the service, by default for
up to one hour. `--wait SECONDS` bounds that single request (0 returns the ticket
immediately); it never repeats acquire calls. Waiting calls renew the ticket's
five-minute stale deadline. After a bounded wait or a transport failure, check
status, then resume with the same selection and `ticketId` before expiry, or
cancel explicitly:

```sh
clankie simulator cancel '{"seatId":"SEAT","holderId":"TASK","id":"TICKET_ID"}'
```

Only that live seat/occupant/holder can cancel. Cancel before changing the
ticket's selection. Dead native owners and expired tickets leave the queue;
unknown native observations do not prove an exit. A queued device is not a lease
and grants no driving authority. `fleet resources` shows the holder, resolved
target, per-device queue position and an estimated wait; pressure or missing
information reports a null estimate, never a promised deadline. The queue
persists across service restarts.

Acquire is idempotent per seat, occupant and holder for a matching selection.
Changing the device or exact model refuses while that holder has a different
lease. `owner_unavailable` after a service restart is usually a failed
observation; a waiting acquire keeps its ticket through two minutes of them, so
retry the same request. A changed occupant or exited process refuses at once.

## Device choice

Acquire prefers an idle existing device of the requested type, then a close model
of the same screen, then another idle iPhone or iPad of the same family on that
runtime; a device with a valid native `lastUsedAt` comes ahead of one with
unknown boot history. `lease.requestedDeviceType` says one stood in; pass
`"exact": true` to require the exact model, and an explicit `deviceId` stays
strict. It creates only when no suitable idle device exists. The CLI reads a plan
first and warns when a new device is needed, since a first boot is expensive;
`clankie simulator plan JSON` reads that advice without reserving or booting. If
you already booted a device by hand, lease it instead of booting another:
`clankie simulator acquire '{"seatId":"SEAT","deviceId":"UDID"}'`.

A successful `verify` describes the existing owned lease: it checks the live
occupant, holder, lease and exact UDID and requires a booted device, acquires
nothing and does not renew the heartbeat. It cannot hold a lock through a
separately issued raw command.

## Cost and capacity

Automatic simulator capacity gives simulators half the machine at the measured
cost of one simulator under test (34 GiB footprint, two cores); memory, not CPU,
usually binds. Load and available-memory guards gate both heavy and simulator
leases, which have independent budgets. A cold boot burns about ten cores for two
minutes, ahead of the one-minute load average, so the governor admits no new
simulator within three minutes of the last one and answers `waiting` with reason
`pressure` ([measurements](../../../../docs/testing/2026-10-09-lean-simulators/README.md)).

Read `usage` beside `holderId` in `clankie fleet resources` or
`clankie simulator status`. Kernel footprint includes private compressed memory;
summed RSS includes shared pages and must not be described as physical RAM used.
Interval CPU uses 100% for one core and can undercount processes that exit
between observations. Partial or unavailable samples do not mean zero, and
samples never grant device authority. Whole-machine admission already includes
these costs, so do not subtract a device's charge a second time.

## Native activity and idle expiry

The lease remains owned by its exact native occupant/processes and task holder.
The service re-proves that identity before granting activity time. A live heavy
request with the same holder keeps it alive while queued or holding a permit
(full, light or server lane); its recorded request process must descend from the
lease's exact native process. Matching labels or reused PIDs alone are insufficient.

Codex roots and children use fresh native `thread/read` state, with complete
parent-thread ancestry back to the seat's root. Claude local children use the
original-native mod's five-second timer and exact `agent.list()` IDs/states.
Reports expire after fifteen seconds, keep original state-change timestamps,
and reject stale/future timestamps, replayed sequences, changed sessions and
wrong producer processes. Waiting/idle children do not borrow a working sibling's
activity. Claude root UserPromptSubmit, PreToolUse and PostToolUse events with a helper
observation timestamp extend only that session's leases to one idle window from
the event. Child hooks do not extend the root. Replay or delayed delivery does
not move the original deadline; future/stale events and changed ownership confer
no time. This is the hook helper's wall clock at invocation, not a timestamp
emitted by Claude. A linked machine whose clock runs ahead confers no time until
the clock mismatch is resolved; future observations fail closed.
Older plugin hooks without this timestamp remain accepted, but do not renew
root leases. Existing question and message delivery remains available.
Stop, StopFailure and SessionEnd renew nothing. There is no permanent
open-until-Stop state: Esc and a blocked prompt can omit Stop.

The worker plugin registers ordinary PreToolUse and PostToolUse renewal as async
hooks, so they carry no tool decision. A shell-only check skips Node and HTTP when
the pane has no root-lease hint. The journal writes a hint for the exact Claude
root holder, indexed by native socket and pane, on grant/update, and removes it
on release/expiry. The hint is not authority: session/process proof still applies.
The shell atomically claims it before reporting. A successful update re-arms it;
otherwise the shell restores the claim unless an admitted service response
explicitly confirms that no matching reservation exists. Timeouts, refusals,
restart errors and non-renewing events therefore leave later hooks able to retry.
A definitively stale hint costs one helper. Release/expiry removes the shared
hint only after the last reservation for that holder, pane and socket ends.
Hints never extend a deadline themselves. Missing hints confer no time; the
normal finite deadline still applies. Child events restore the existing hint
without moving that root's deadline. Ordinary hooks remain best-effort:
two-second HTTP timeouts and five-second native command limits. Only PermissionRequest and AskUserQuestion retain the long
question wait. Sessions without simulator reservations skip resource owner proofs.
The shell hint lookup uses `CLANKIE_STATE` or `$HOME/.clankie`; it must match the
OS owner's `.clankie` root used by the machine governor. Changing worker HOME or
CLANKIE_STATE does not move that registry and can cause missing hints. The scratch
fixture explicitly aligns the paths. New registrations take effect after
`/reload-plugins` or a new session; shipping the
service does not change an existing seat's loaded hooks. Do not reload or restart
someone's seat to obtain coverage. Older hosts receive the legacy hook body after
a definite HTTP400 rejection; they do not gain event renewal.

A single non-heavy tool call or quiet thinking beyond one idle window remains
uncovered for Claude roots. The required native API must positively report the
current root turn for the exact session/process and become idle on interrupt.
Exact-holder queued/held heavy work already covers long heavy commands. A plain
background process does not hold a simulator lease; a general process-holder path
is a separate slice. Other unsupported/unavailable native activity fails closed.

After verified work ends, the normal idle deadline starts at the prompt's native
state-change time (or its first verified idle observation). Repeated idle reports
cannot move that deadline. Lost observation starts expiry from the last proven
activity; it never freezes a cached working state. Explicit touch still extends
the normal idle deadline. Run long waits as blocking, process-owned jobs in the
harness background; never run model sleep/touch loops. Release when finished.

Activity observations are deliberately not durable authority: an observer restart
must re-prove activity and otherwise falls back to the lease's explicit-use
clock. Reservation stale caps, runaway checks, explicit ownership checks and exact
device shutdown/cleanup remain independent of activity.

## Release and lease end

Release answers within about twenty seconds. `held` with `retryAfterMs` means a
native boot or shutdown is in flight and the release settles it; read status
after the retry rather than releasing again. A reservation that never started its
device is released at once; one that starts no device within five minutes frees
its slot by itself.

Each iOS 27 boot burns about 15 cores in its first minute, then re-renders its
wallpaper posters at 10-12 cores about two and a half minutes in; that is
expected. After the three-minute boot window, an untouched device holding four
cores for two minutes while the machine is refused for load or memory is shut
down early as a `runaway`. Each lease end is recorded with its reason
(`released`, `idle`, `runaway`, `owner_exited`, ...) in `simulator-settled.jsonl`,
and your next touch, verify or release names an `idle`, `runaway` or
`owner_exited` end ([measurements](../../../../docs/testing/2026-10-19-simulator-runaway/README.md)).

Clankie never shuts down a device it did not lease; it names such devices in
status and doctor and tells the lead of the seat using one. A missing or
uncertain create receipt remains held for operator review: do not retry native
create or infer ownership from a device name. A stopped observer preserves
leases.
