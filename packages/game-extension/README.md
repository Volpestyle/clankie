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
Minecraft and Rivals adoption and installed-extension discovery remain the
follow-ups documented in the ADR. The shipped contract alone does not register
HTTP routes, tools or settings screens, or confer permissions.
