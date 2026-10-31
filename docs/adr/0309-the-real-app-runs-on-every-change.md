# ADR 0309: The real app runs on every change

Status: accepted (James, 2026-10-31).

## Context

James asked for checks that validate the real running app instead of a growing
suite of tests that slow landings down. [ADR 0221](0221-tests-prove-the-product-and-its-boundaries.md)
already ranks a full end-to-end run first, but no single command ran the product
the way the owner, his agents and the app reach it. Most of the suite's 1,107 files
start pieces of the service in-process with stand-ins; what landed broken on
2026-10-31 (#53 to #56) was environment-tied integration timing, not logic a unit
test guards. On a landing, tests take about two minutes of a twelve-minute gate;
typechecking takes most of the rest.

## Decision

`pnpm real-run` ([`packages/real-run`](../../packages/real-run/README.md)) starts this
checkout's real service and relay as plain Node processes in a fresh scratch home
(`scripts/scratch-stack.mjs --broker-operator`), with his own private bundled Herdr
under that home's state. It drives the owner's key flows through the headless CLI
and HTTP, as an agent or the app would, and checks every outcome through the API,
the files the service writes and the service's own structured log. A run fails if
the service logs anything at error level. Nothing is mocked and no model is called.

The run uses Effect for its own steps and logging only: each flow is a traced
span, and every line, CLI call included, is JSON in `run.jsonl` beside the
service and relay logs and `report.json`. The service keeps its pino logger.

It runs as the `real-run` job on James's Mac runner for every ready
same-repository pull request, and never for code from a fork. Main does not
rerun it after the merge (ADR 0310).

No AWS emulator is needed. Since the reshape (ADR 0300) nothing Clankie runs talks
to AWS: evidence defaults to local files, and the phone's doorway is the relay,
which the run starts for real. A hosted piece that comes back gets an emulator
only where the run cannot reach the real thing.

### What it covers

Boot with his own Herdr fleet, owner authority over HTTP, status and seat, the app
relay, project creation on a real repository, the feed (drop, check, answer),
the autonomy dial, a check routine through the fleet's heavy permits, a hire
through real admission, and that all of it survives a service restart. A hire
with no signed-in harness is refused by name before a pane opens: the scratch
home holds no harness account, so a launched worker is out of reach here.

### Pruning

An integration test whose whole claim a flow now proves is removed in a reviewed
batch, recorded in the [test-pruning review](test-pruning-review.md). Kept regardless:
trust-boundary proofs (seat binding, the process census, who may connect, device
pairing and gateway encryption), published contracts, and the fast tests.

## Consequences

- A change that breaks how Clankie starts, answers or keeps state fails the Mac
  job, whatever its unit tests say.
- A new owner-facing flow adds a flow to the run rather than a new mocked test.
- The run cannot yet launch a worker or exercise Watch mode; each is added when the
  run can reach it.
