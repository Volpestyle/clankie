# @clankie/game-extension

A typed composition contract for game extensions. Games keep their own motors,
actions and observations; core supplies durable authority and approved host
ports. See [ADR 0234](../../docs/adr/0234-games-share-one-extension-contract.md).

An extension declares `contractVersion: 1`, `id`, `connector`, `skill`,
`settings` (existing key and parser), `activity` (surface or `null`), and
`create(host)`. Its runtime implements `start(request, control, onRunning)`,
`stop(sessionId)`, `status()` and `health()`. Await status/health; a connector
may implement a read-only remote check, while the shared wrapper returns local
projections immediately.

`createGameExtensionRuntime` supplies the shared local lifecycle. It checks the
host guard before entering execution and before `onRunning`. The connector
must check the same guard at every effect and call `confirmStopped` only after
exact departure or a proven no-join refusal. A settled promise, timeout, stop
request or health result cannot release the host's play lease. Unconfirmed
cleanup retains `uncertain` and rejects another start. Core owns restart
recovery; this helper is deliberately not a durable lease store.

`ready` is local lifecycle health. It does not probe credentials, worlds,
media or models. Request and result remain extension-typed, so the host can
preserve existing validated game APIs and refusal receipts.

[Pokémon](../../integrations/pokemon/README.md) is the first implementation.
Minecraft also implements it. `GameExtensionRegistry` validates descriptors,
creates trusted factories with approved host ports, returns their typed runtime,
and projects local state through a bounded catalog. Registering metadata does
not import code, install packages or grant authority. Factories stay inert until
execution or explicit activation.

A host can associate its typed tool/route projection with a registration.
`projections()` returns only current registrations. `unregister(id)` fences new
starts, verifies idle state, quiesces optional capture/polling and removes the
entry; held or uncertain state refuses. Native entry points bind the same
registration guard so a stale reference cannot join after removal.

`reconcileStopped(id, proof)` is host-only. Use it inside the existing durable,
incarnation-fenced recovery operation after exact connector termination. A
failed proof or still-running executor cannot clear uncertainty. It does not
release the host ledger. Rivals lifecycle adoption remains VUH-1849.
