# Minecraft

Clankie can join an owner-configured Java server as his own offline player,
chat, follow a player, navigate, dig, place blocks, craft inventory recipes and
build a sequence of placements. His existing conversation chooses the actions;
the service-owned MCP motor handles physics and navigation.

The first supported slice is a local or private-LAN offline test world. Microsoft
accounts and online authentication are deferred. This does not prove a live
friend session or Discord call. The local manual conformance script verifies
the motor independently through Paper RCON; ordinary CI never starts a world.

## Configure and join

Run these from the source checkout or an installed release containing the motor:

```sh
clankie minecraft configure local 127.0.0.1 --port 25565 --version 1.21.4 --username Clankie
clankie minecraft join local
clankie minecraft status
clankie minecraft chat Hello from Clankie
clankie minecraft follow FriendName 2
clankie minecraft cancel
clankie minecraft leave
```

`/minecraft` offers the same commands in the console. `--conversation ID` binds
CLI operations to an existing conversation; the console uses its selected
conversation. Configure settings with the CLI or operator API, rather than
editing the settings file. `configure` without arguments shows profiles and
allowlists; `configure remove PROFILE` removes a profile.

Profiles hold an id/name, host/port, Java version, username and explicit
`offline` auth. Model tools see only profile ids/names. DNS and Minecraft SRV
targets are resolved and checked before connection; the motor dials the checked
literal address. Loopback and private network addresses are allowed. Public
targets require `configure allow-public HOST [PORT]` for the resolved target
or its literal address; `configure revoke-public HOST [PORT]` removes that grant.
An SRV redirect to a public target needs approval for that target and port.

## Actions and ownership

`goto X Y Z [TOLERANCE]`, `dig X Y Z`, `place X Y Z ITEM`, `craft ITEM COUNT`,
`follow PLAYER [DISTANCE]`, and `chat TEXT` return an action handle promptly.
`action JSON` accepts the domain action shape, including `build` with placements.
Use `action-status ACTION` to inspect settlement and evidence. Crafting is
currently limited to recipes available without a crafting table.

`cancel [ACTION]` clears navigation and controls and stops active digging.
`pause` stops current work and retains the session; `resume` admits fresh actions.
An already-sent placement or craft can remain uncertain after cancellation.
Completion and verified effects are separate: only fresh server packets can
verify a block or inventory postcondition. Optimistic Mineflayer cache updates
and local completion text do not prove success. Unknown evidence stays unknown.

Minecraft holds the same `play` lease as Pokémon, from before join through a
confirmed disconnect of the exact bot session/generation. Other conversations
receive a busy response. Restart, connection loss or a timeout alone never
release the lease. `clankie body recover play` attempts exact reconciliation;
an unmatched or missing motor cannot establish that the old bot disconnected.
Raw MCP, worker and fleet calls cannot bypass the service-owned Minecraft tools.
World chat and signs are untrusted observations and grant no machine authority.

## Watch

The motor serves prismarine-viewer's browser client on loopback and screenshots
it with headless Chromium. Chrome is an external dependency, as for browsing;
no native canvas or GL addon is needed. Set `CLANKIE_MINECRAFT_CHROMIUM` to an
executable path when Chrome is installed elsewhere. Frames are PNGs at 320×180, bounded to
256 KiB. The service publishes them through the existing brokered Activity
producer, with session checks and no overlapping capture requests. Disconnect
closes the producer so the viewer cannot retain a stale live frame.

In an admitted Discord voice channel, `/clankie watch surface:Minecraft` selects
the Minecraft Activity. It uses `DISCORD_ACTIVITY_APPLICATION_ID_MINECRAFT` when
set, otherwise the existing `DISCORD_ACTIVITY_APPLICATION_ID_GBA`. The producer
credential and usual Activity setup are still required. Frame dimensions set
the viewer's aspect ratio. This wiring requires a separate live Discord check;
local PNG inspection alone does not establish continuous viewing in a call.
The current 1.21.4 renderer is rough; inspected local frames include missing
textures. It is suitable for the first automated view, pending live validation
and visual refinement.

## API and manual proof

Operator-authenticated `GET /v1/minecraft` reads status; `POST /v1/minecraft`
dispatches the typed command (`join`, `act`, `cancel`, `leave`, etc.).
`GET`/`PUT /v1/minecraft/configuration` reads or replaces the offline settings.
Use `x-clankie-conversation-id` for an existing conversation; omitted selects the
default console conversation. Endpoints never accept account credentials.

The owned adapter's [README](../integrations/minecraft-mcp/README.md) records
the pinned upstream provenance, dependencies and manual RCON conformance
command. [ADR 0219](adr/0219-minecraft-is-an-mcp-connected-body.md) explains
the body, evidence and viewing boundaries.

`pnpm --filter @clankie/clankie minecraft:smoke --output DIRECTORY` runs an
isolated service and the real HTTP/CLI flow against the loopback Paper fixture
in `~/dev/minecraft-spike`, with a second scripted player and RCON evidence.
It saves a report and three captured frames without changing owner settings or
restarting the running service. `--routes-only` exercises the production
Minecraft routes without the rest of the app's import graph; the report labels
that narrower scope. Both modes are manual checks, outside CI and evals.
