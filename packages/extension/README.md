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
ready, each in its own boundary; `report` reads health; `snapshot` gives the
last known states without reading health; `projections` returns
only running extensions' additions; `stop` stops every extension, or only the
ids it is given, so each keeps its place in the host's shutdown order. A bad setting, a throwing factory, a failed
start or an unhealthy report marks only that extension `degraded` with a fixed
reason, removes its projection and calls `onDegraded` once. Nothing an
extension throws reaches the fleet.

Games keep the richer `GameExtension` contract. Its types live here too, so an
outside game imports one package; [`@clankie/game-extension`](../game-extension/README.md)
keeps the host's runtime pieces (the registry and lifecycle wrapper) and
re-exports the types for the games in this repository.

## Outside extensions

An extension that lives outside this repository plugs into the same contract
([ADR 0338](../../docs/adr/0338-outside-extensions-plug-into-the-same-contract.md)).
This package is its SDK: it imports nothing else from Clankie and builds to
plain JavaScript with types (`pnpm --filter @clankie/extension build`; `pack`
builds first). It is not published yet; publishing means removing `private`
and running `npm publish` from this folder.

**It is not a sandbox.** An outside extension runs in the service's own
process as the owner's user. The permissions below bind honest code: they keep
its reach visible and its mistakes contained, and nothing stops hostile code
from importing `node:fs`. The owner adds only code they trust.

The frozen v1 surface (`OUTSIDE_CONTRACT_VERSION`; the host accepts the current
and previous version, and v1 is the first):

- **Manifest**, `clankie-extension.json` at the extension's root or a `clankie`
  field in its `package.json`, read without running any code
  (`parseExtensionManifest`, `readExtensionManifest`):

  ```json
  {
    "id": "weather",
    "version": "0.1.0",
    "contracts": [1],
    "kind": "extension",
    "entry": "src/index.ts",
    "permissions": ["options", "state", "credentials", "tools", "routes"]
  }
  ```

- **Permissions** (`OUTSIDE_PERMISSIONS`), each granted or refused by the owner:
  `options` (its non-secret options), `state` (a private 0700 directory),
  `credentials` (broker API keys named `ID` or `ID-*`), `tools`, `routes`, and
  for games `play` (the shared play ledger) and `go-live`.
- **`OutsidePorts`**: `options`, `stateDirectory` and `credential(name)`. A
  `kind: "extension"` entry exports `extension`, an `OutsideExtension` whose
  `needs` names the ports it uses; a refused one leaves it `degraded` with
  `permission_refused_NAME`. A `kind: "game"` entry exports the game module
  (`gameExtensionApis`, `gameExtension`, `projectGameExtension`) and receives a
  `GameExtensionModuleHost`, the outside ports plus play.
- **Projection** (`OutsideProjection`): captain tools named for its id (`weather`
  or `weather_*`; anything else is dropped), exact routes under `/v1/ext/ID/`
  (a game may also use `/v1/ID`) behind the owner's authentication, and its
  `health()` as its row in `clankie doctor` and `clankie extensions`. A tool
  inherits the calling conversation's authority, sees only `{ conversationId,
current }`, and returns untrusted model input.

`createTestHost({ manifest, granted, options, credentials })` runs a
`kind: "extension"` against fake ports with the real host's rules, for an
author's own tests. Installing one is `clankie extensions add` ([CLI
reference](../../docs/cli.md#outside-extensions)).
