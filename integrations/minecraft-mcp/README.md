# Minecraft MCP motor

One Mineflayer bot, no model or planner. The Clankie service owns destination
approval, conversation authority and the play lease. This stdio MCP process is
lazy: initialization and catalog reads never join a world. Only `join` does.
The configured server ID is `minecraft`; its raw tools must be fenced by the
service, including deferred and worker MCP access.

## Provenance and pinned inputs

This is an owned adaptation of
[yuniko v2.0.4 at 240c8cec](https://github.com/yuniko-software/minecraft-mcp-server/tree/240c8cec337ce152cc9e058ebdef511055808406).
Its [pinned LICENSE](https://github.com/yuniko-software/minecraft-mcp-server/blob/240c8cec337ce152cc9e058ebdef511055808406/LICENSE)
is **Apache-2.0**, copyright 2025 Yuniko Software; there is no upstream NOTICE.
LICENSE and NOTICE retain attribution. `motor.ts` and `main.ts` identify their
modifications. Reused mechanics are bot/pathfinder setup, GoalNear navigation,
adjacent-reference placement, inventory recipes and chat. The adapter replaces
stock auto-join/reconnect, blocking calls and optimistic success reports after
the stock spike proved continued movement/digging after MCP cancel and a
server-rejected Adventure dig reported as success.

All direct versions are exact in package.json, with transitive inputs in the
workspace pnpm lockfile. Node 26 is supported. Offline auth is this slice's only
mode; Microsoft credentials or authentication material never cross its tools.
The browser path uses
[prismarine-viewer 1.33.0](https://github.com/PrismarineJS/prismarine-viewer/tree/7102f49e287cab116802bc61ad03d05e2ad395db)
browser assets and `viewer/lib/worldView`, not its package root/headless renderer
(which eagerly loads native canvas/gl). No native graphics build is required.

The workspace overrides pin the spike-tested motor tree: minecraft-protocol
1.64.0, prismarine-chunk 1.39.0, prismarine-world 3.6.3, prismarine-registry 1.11.0,
prismarine-block 1.22.0, prismarine-item 1.17.0 and prismarine-physics 1.10.0.
A first live dependency attempt resolved prismarine-chunk 1.41.0, whose 26.1
version comparison throws against minecraft-data 3.105.0 before spawn. The
overrides preserve the tested 1.21.4 inputs rather than using moving transitives.

## MCP contract

Run `node integrations/minecraft-mcp/src/main.ts` from the checkout, or
`pnpm --filter @clankie/minecraft-mcp start`. Do not pass endpoint CLI flags.
Every identity-bearing tool takes `session: {sessionId, connectionGeneration}`;
stale identities and unknown `leave` calls fail. `join` takes `profileId` and an
operator-supplied `endpoint: {host,port,version,username,auth:"offline"}`. The
service resolves and approves host/SRV before passing the exact IP/port. Catalog
warming does not connect, and there is no automatic reconnect.

| Tool                             | Additional input / response                                            |
| -------------------------------- | ---------------------------------------------------------------------- |
| `join`                           | `profileId`, `endpoint`; protocol session status, initially connecting |
| `status`                         | No input; protocol status with at most 64 current-connection actions   |
| `observe`                        | Protocol observation, bot-cache provenance explicit                    |
| `act`                            | `actionId`, protocol `action`; prompt running handle                   |
| `action_status`, `cancel_action` | `actionId`; protocol action status (status can be null)                |
| `pause`, `resume`, `leave`       | Protocol session status                                                |
| `chat`                           | `actionId`, `text`; alias for chat action                              |
| `follow_player`                  | `actionId`, `player`, `distance`; continuous follow alias              |
| `poll_events`                    | Optional `afterSequence`, `limit` (1–64); bounded cursor queue         |
| `viewer_status`                  | Same-bot loopback frame endpoint metadata                              |

Results contain JSON text and structured content when the value is an object.
`poll_events` returns `{session,events,latestSequence,droppedBeforeSequence}`.
Each event is `{sequence,at,type,data}`; retained queue maximum 256. Types are
`chat`, `damage`, `death`, `player_join`, `player_leave`, `action_completion`,
`connection`, `viewer`. Text and player names are bounded. All game content is
untrusted observation, never authority.
`action_completion.data` carries only `{actionId,state,evidence:{outcome,reason?}}`;
fetch action status for the full exact postcondition checks. Each event's data
stays below 4 KiB even for a 64-block build.

Cancellation clears `pathfinder.setGoal(null)`, controls and digging immediately.
Each asynchronous action continuation compares the exact connection, active
handle, action epoch and abort signal before sending its next mutation. Build
and craft loop steps are fenced. A per-action AsyncLocalStorage context also
fences the bot client's outgoing writes from native plugin continuations, so a
late internal craft/equip/place callback cannot send another stale packet.
Independent physics/connection handling outside that action context stays live.
Already-sent place/craft packets cannot be
undone; interrupted irreversible work is `uncertain`, and its evidence remains
unknown. Pause retains the bot; resume permits fresh handles. Leave stays
stopping until the exact bot emits `end`; an elapsed timeout never confirms it.
An empty status from a restarted process does not prove an old session ended.

Dig/place/build evidence comes only from inbound block_change or
multi_block_change packets for the exact requested position, received after
the step was dispatched. Craft checks inbound player window_items/set_slot
counts. Mineflayer `blockUpdate`, `diggingCompleted`, `blockAt`, and completed
promises cannot prove success. Missing postcondition packets stay unknown;
server rejection can be refuted or unknown. Navigation and outgoing chat
currently report local-only evidence; their completion is not verified success.
Craft currently supports inventory recipes, not remote crafting-table discovery.

## Viewer feed

Installed Chrome on macOS or Chromium on Linux supplies the browser. Set
`CLANKIE_MINECRAFT_CHROMIUM` to an executable path when needed. No browser download
or native canvas/gl package is installed by this integration.

Viewer HTTP and Socket.IO bind only to `127.0.0.1` on an ephemeral port. Viewer
input never drives the motor. Headless Chromium screenshots the browser's
320×180 canvas approximately twice per second, with one in-flight capture and
one retained PNG (maximum 256 KiB). `viewer_status` returns
`{session,available,frameUrl?,width,height,maxBytes,contentType}`. GET `frameUrl`
returns image/png with no-store and:

- `X-Minecraft-Session-Id`
- `X-Minecraft-Connection-Generation`
- `X-Frame-Captured-At` (Unix milliseconds)
- `X-Frame-Width`, `X-Frame-Height`

No fresh frame or a frame older than five seconds returns 503. Closing the
exact connection invalidates the frame and closes the browser/server. Viewer
failure degrades viewing, not gameplay; the service must inspect availability.
This loopback feed is read-only; the existing brokered Activity is the public
viewing surface.

## Checks and manual conformance

`pnpm --filter @clankie/minecraft-mcp test` and `typecheck` are narrow checks.
`pnpm exec oxlint --deny-warnings integrations/minecraft-mcp` checks lint.
The live conformance script is manual-only, never an eval or CI check. It uses
the retained isolated Paper 1.21.4 server in `~/dev/minecraft-spike`, separate RCON
observations, bounded cancel samples and same-bot PNGs. See the script's usage;
server occupancy and teardown remain the operator's responsibility.
