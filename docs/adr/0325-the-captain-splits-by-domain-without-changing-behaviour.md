# ADR 0325: The captain splits by domain without changing behaviour

Status: Accepted, 2026-11-01, as step 6 of the Clankie cut and reshape that
James approved ("split captain.ts + Effect pilot").

## Context

`apps/clankie/src/captain/captain.ts` was 9,620 lines on 2026-11-01. Almost all
of it is one function, `createCaptain`, whose body runs from line 451 to 9,598:
about 290 top-level statements that share one closure, followed by a returned
`CaptainPort` object of about 2,570 lines. A single method of that object,
`submitDiscordTurn`, is about 940 lines.

Earlier extractions (Discord turns, the operator service, the conversation
runner, worker reports) already set the pattern this ADR keeps: a
`createX(context)` factory in its own `captain-*.ts` file, given a typed
context, with getters for anything the captain builds later. What was missing
was a map of the rest, an order, and a rule that keeps each move small enough
to merge while other sessions keep editing the same file.

Measured from the closure's own declarations (which statements declare which
names and which other closure names they read), the body falls into these
domains. Line ranges are from 2026-11-01's `main` and move as the split lands.

| Lines (approx.) | Domain                                                                                                            | Reads from the closure | Read by the rest |
| --------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------- |
| 452–530         | Settings store, Watch gate, Discord turns wiring                                                                  | few                    | many             |
| 530–765         | Fleet runners: remote fleets, census breaker, pane-gone feed, Herdr core, routed runner                           | ~20                    | many             |
| 765–1305        | Claude worker seats, hook questions, hire registry and project resolution                                         | ~30                    | ~10              |
| 1305–1500       | Evaluator and turn metrics; personas and live seat state; prompt and message edges                                | few                    | many             |
| 1495–1684       | Head seat, seat outboxes and fleet mailboxes                                                                      | ~15                    | many             |
| 1684–2200       | Settings for context, model runtime, prompts, `buildSession`, durable sessions                                    | ~25                    | many             |
| 2212–2240       | Credential health                                                                                                 | 1                      | 3                |
| 2746–2919       | Checkout status, sync, cache reclaim, worktree prune                                                              | 5                      | 6                |
| 2971–3461       | Hiring: start queues, admission, roster, issue status, work intents                                               | ~40                    | ~10              |
| 3461–4140       | Seat delivery and lead messages; room conversations and conversation drivers                                      | ~40                    | many             |
| 4140–5016       | Fleet observation: tool catalog health, fleet refresh, shared census, projection                                  | 47                     | 11               |
| 5016–5248       | Fleet and runtime health alerts                                                                                   | 15                     | 3                |
| 5248–5487       | Bounded fleet reads, the roster, device names, the fleet snapshot                                                 | 27                     | 6                |
| 5487–5746       | Routines; usage limits, efficiency and fleet rounds                                                               | ~25                    | 6                |
| 5746–6028       | Projects on Auto rounds                                                                                           | 14                     | 4                |
| 6028–6441       | Lead seats, failover, lead restarts, hired seat restarts                                                          | 28                     | 16               |
| 6441–6513       | Auto tidy and closed seat history                                                                                 | 14                     | 4                |
| 6513–6829       | Inbound receipts, source proving, worker report routes, fleet write authority                                     | 16                     | 7                |
| 6829–7029       | Huddles, peer messages, the review gate                                                                           | 16                     | 3                |
| 7030–9598       | The returned `CaptainPort`: Discord turn submission, seat events and messages, operator glue, voice, lane prompts | —                      | —                |

## Decision

- **One domain per module, one module per pull request.** Each move takes one
  row above (or one large `CaptainPort` method) into a `captain-*.ts` file
  beside the captain, as `createX(context)` returning the same names the
  closure used. The captain destructures them under those names, so nothing
  else in the file changes.
- **The move changes no behaviour.** Code moves as text. The only edits allowed
  inside it are re-pointing a captured name at the context (`paneTidy` becomes
  `ctx.paneTidy`) and the imports and constants it takes along. Construction
  order stays where it was: the factory is called where the moved statements
  used to start, so every eager side effect runs at the same moment.
- **Late state is read through getters.** A name the captain builds after the
  factory is called, or reassigns, is passed as a getter on the context, the
  way `createWorkerReports` already reads `deliverToSeat`. A name that exists
  already is passed by value.
- **Proof for each move.** The moved block is diffed against its original and
  must differ only by the re-pointed names; the service typechecks; the tests
  that reach the moved code run; and the pull request merges only green. No
  new tests are written for a move that changes no behaviour (ADR 0221).
- **Order: leaves first.** Domains that read little and are read by little go
  first (checkouts, health alerts, Auto rounds, auto tidy, huddles and
  reviews, inbound sources), then the state they all share (live seat maps,
  outboxes and mailboxes, fleet runners), then the large consumers (fleet
  observation, hiring, seat delivery, lead seats), and last the big
  `CaptainPort` methods. Each move shrinks the next one's context.
- **Concurrent work rebases onto the moves.** Other sessions keep editing the
  captain. A move rebases on `main` right before it merges, and a conflict in
  moved code is resolved by applying the other change inside the new module.
- **Fleet observation is the Effect pilot's ground.** Once fleet observation
  stands on its own, a separate pilot tries the Effect library (already used
  by `packages/real-run`) on one seam of it, behind the same behaviour and
  with real-Herdr tests. Whether Effect goes further is decided by its own ADR
  from what the pilot measures, not here.

## Consequences

- `captain.ts` shrinks pull request by pull request; each one is reviewable on
  its own and safe to revert alone.
- Every module's context names exactly what it depends on, which is the map
  the next refactor (and the Effect pilot) needs.
- Getter contexts are verbose. That is the price of keeping construction order
  and live bindings identical; a later change may replace a getter with a value
  once the module that builds the name is itself moved earlier.
- The table above is a snapshot and is not kept current; the architecture
  reference's source map lists the modules as they land.
