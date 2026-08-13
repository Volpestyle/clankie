# ADR 0087: One loopback plane between the runner and the control plane

Status: accepted (James, 2026-08-09).

## Context

Every capability the control plane reads from the runner arrived with its own
HTTP server on its own port: worker transcripts on 4313, activity observations
on 4314, the agent census on 4315, the browser on 4316, and — as of
[ADR 0086](0086-clankie-holds-a-shell.md) — the shell on 4317.

Each server re-implemented the same four things. `authorized()` and `json()` were
**byte-identical** across all four gateways that had them (`c07e7b`, `7c9e77`);
`readBody()` was identical in both that needed it. The listen/bind/close block
differed only in its error string. On the control-plane side, five client classes
each re-validated the same loopback origin, rebuilt the same bearer header, and
re-checked the same status code.

That is 596 lines of runner gateway and 348 lines of control-plane client to
express five route tables and one credential boundary. The pattern also
propagated: adding the shell meant copying a gateway and changing the nouns,
which is how a fifth port appears without anyone deciding there should be one.

Ports were not free either. `agent-browser`'s 4316 already collided with
`SLACK_BRIDGE_PORT`, whose default is also 4316.

## Decision

**One gateway, one port, one route table per capability.**
`apps/runner/src/loopback-gateway.ts` owns the server, the bearer check, the
body reader, and the JSON writer. A capability is a
`(context) => Promise<boolean>` that returns `true` when it owned the request.
The plane listens on **4313** (`CLANKIE_RUNNER_LOOPBACK_PORT`); 4314–4317 are
retired.

**Capabilities register rather than being constructed together.** They do not
all exist at once — transcripts and the census are ready as soon as the runner
can authenticate, while the browser and the shell wait on doctrine compiling. A
capability that never registers is a 404, which is exactly what an absent
gateway used to be.

**One transport on the control-plane side.** `RunnerLoopback` validates the
loopback origin and holds the bearer; `runnerPorts()` builds all five ports from
it. The five _interfaces_ stay, because they are the injection seam a test uses
to hand `app.ts` a fake census without standing up a runner. What collapsed is
the five implementations behind them.

**A failed bind no longer kills the runner.** Missions execute over the
control-plane connection, not over this plane, so a port collision now costs
Clankie his census and his browser rather than his ability to work. This matches
the terminal gateway's existing behavior and is how the collision above would
have surfaced as a log line instead of a dead runner.

## Consequences

- 944 lines become 553; five servers become one; five ports become one.
- `CLANKIE_WORKER_TRANSCRIPT_PORT`, `CLANKIE_ACTIVITY_OBSERVATION_PORT`,
  `CLANKIE_AGENT_CENSUS_PORT`, `CLANKIE_BROWSER_PORT`, and
  `CLANKIE_CAPTAIN_SHELL_PORT` are replaced by `CLANKIE_RUNNER_LOOPBACK_PORT`.
  On the control-plane side the five `CLANKIE_*_URL` variables become
  `CLANKIE_RUNNER_LOOPBACK_URL`.
- A new capability is a route table and one `register` call. There is no server
  to copy, which is the point: the previous shape made copying the path of least
  resistance.
- Unknown paths now 404 where an unknown method to a known path 405s. Previously
  two gateways checked the method before the path and answered 405 to both.
- The transcript tail keeps its own handler. It streams NDJSON with backpressure
  rather than returning an envelope, so it reaches past the JSON helpers on both
  sides — the one capability that genuinely differs.

## Why not go further

A fully generic `/v1/runner/*` forward would delete the remaining route tables,
but the browser's `call` route legitimately inspects the projected descriptor to
decide whether an operator bearer is required. One capability out of five needs
real logic in the control plane, and a generic forward would have to grow an
exception for it. The route tables stay.
