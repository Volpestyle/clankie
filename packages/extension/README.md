# @clankie/extension

The one contract for the parts Clankie can run without
([ADR 0328](../../docs/adr/0328-clankie-is-a-core-with-extensions.md)). The core
boots and serves the fleet with no extension at all; the Discord persona,
voice, World, games, Watch, each tracker adapter, the relay, computer use, the
browser and media plug in through this package.

An extension declares `contractVersion: 1`, an `id`, its `settings` (key and
parser), and `needs`: the names of the core ports it may use. `create(host,
settings)` receives only those ports, frozen, and must be inert: no network, no
model call, no join. Its runtime implements `start(signal)`, `stop()`,
`health()` and an optional `projection()` of the tools, routes, commands and
checks it adds while it runs.

`ExtensionSupervisor` is the composition root's side. `add` parses settings and
creates the runtime; `start` starts every created extension after the core is
ready, each in its own boundary; `report` reads health; `projections` returns
only running extensions' additions. A bad setting, a throwing factory, a failed
start or an unhealthy report marks only that extension `degraded` with a fixed
reason, removes its projection and calls `onDegraded` once. Nothing an
extension throws reaches the fleet.

Games keep the richer `GameExtension` of
[`@clankie/game-extension`](../game-extension/README.md), which shares this
package's descriptor and health types.
