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
Pass `--motor /absolute/path/to/main.js` to run the same probes against a compiled
motor and its adjacent runtime packages outside the checkout.

The workspace override replaces server-side `vec3` resolution with the independent
Apache-2.0 [`@clankie/vec3`](../../packages/vec3/README.md) package. Manual motor
conformance and archive assembly passed with the release license gate unchanged.
Prismarine-viewer's precompiled browser assets remain vendor assets; the override
does not assert they were rebuilt.

## Integration-owned hosting

`hosting.ts` owns local Paper lifecycle, pinned plugin provisioning, loopback RCON,
backups and auth. `tunnel.ts` owns pinned playit provisioning, broker-backed claim,
mandatory PROXY V2, its supervised process and configuration checks. Claim start
returns `preparing`; its retained build job publishes the approval URL through
claim status, and completion exchanges credentials directly into the broker. `main.ts`
projects those operations through the same private MCP connection as the motor.
The AWS provider implements the same `MinecraftHostingPort` for one configured
EC2 instance. It uses a scoped broker credential, bounded custom SSM management,
encrypted secret-bearing replies and a private SSM bot port forward. Guest
provisioning keeps Paper/RCON loopback, with trusted public ingress supplying
original client addresses. The guest idle/uptime watcher must remain independent
of the controller; CloudWatch provides an additional stop path, while Budgets
provides alerts rather than a spending cap. Account/resource records stay private.
No server or tunnel starts merely because the MCP connection opens. Clankie's core
retains authority, Discord bindings/invites, audit, profiles and play ownership.

Tunnel status includes only stable public error codes; provider response bodies
and credentials never cross the status projection into Clankie's tools. Account
claim completion is separate from allocation: `playit-email-verification-required`
requires the owner to verify their playit account email before retrying start.
Startup launches the claimed pinned agent before its first allocation request,
so playit can register the executable's supported version and configuration.
`playit-agent-version-too-old` reports a registration/version rejection;
`playit-api-invalid-request` reports an incompatible request, without exposing
the upstream validation message.
An interrupted allocation is reconciled against the agent's actual tunnels on
the next start, adopting the matching owned tunnel. A filesystem lease excludes
concurrent creates; a private allocation receipt distinguishes confirmed rejection
from an uncertain result. Rejection permits a retry, while an uncertain result
with no visible tunnel remains `playit-tunnel-allocation-pending`. Legacy markers
without receipts are checked repeatedly before recovery. Ambiguous matches
refuse startup rather than allocating duplicates.

The local default is Java 21, Paper 1.21.4 build 232 and game/RCON ports 25684/25685.
Pinned ViaVersion 5.12.0 admits newer clients through 26.3 without changing the
bot/viewer protocol. Host status and invites list supported clients.
Hosting data/settings are integration-owned under the supplied `--data-dir`.
Empty-server timeout defaults to 15 minutes; maximum requested-run uptime to six
hours, including crash restarts. Shutdown saves/backs up and stops the tunnel.
Configuration is stopped-only. See [hosting setup](../../docs/minecraft.md#host-clankies-own-server).

Premium enrollment prepares both the persisted FastLogin premium marker and an
AuthMe account before whitelist admission. The pinned FastLogin
[AuthMe hook](https://github.com/TuxCoding/FastLogin/blob/1.12-kick-toggle/bukkit/src/main/java/com/github/games647/fastlogin/bukkit/hook/AuthMeHook.java)
uses API registration, but AuthMe 5.6.0's
[registration precheck](https://github.com/AuthMe/AuthMeReloaded/blob/5.6.0/src/main/java/fr/xephi/authme/process/register/AsyncRegister.java)
rejects that API path while player registration is disabled. Enrollment uses
AuthMe's [native administrator registration](https://github.com/AuthMe/AuthMeReloaded/blob/5.6.0/src/main/java/fr/xephi/authme/command/executable/authme/RegisterAdminCommand.java)
with an internal random password, preserves an existing account's hash, and
verifies the account row before admitting the name. No password or code is
issued to a premium friend; player self-registration stays disabled.
After plugin readiness, startup also repairs missing AuthMe accounts only for
the intersection of this host's whitelist names and persisted FastLogin
`Premium=1` records. This migration preserves existing accounts and changes
neither premium classification nor whitelist membership.
`premiumUuid: false` preserves the established offline-mode player identity for
world data and whitelist compatibility. In FastLogin's pinned
[verification path](https://github.com/TuxCoding/FastLogin/blob/1.12-kick-toggle/bukkit/src/main/java/com/github/games647/fastlogin/bukkit/listener/protocollib/VerifyResponseTask.java),
Mojang session authentication occurs separately from optional UUID rewriting.
AuthMe must retain `settings.useAsyncTasks: true` for FastLogin's async hook.
In pinned 5.6.0, [task dispatch](https://github.com/AuthMe/AuthMeReloaded/blob/5.6.0/src/main/java/fr/xephi/authme/service/BukkitService.java)
uses that flag to schedule AuthMe work or run it inline, and the
[login precheck](https://github.com/AuthMe/AuthMeReloaded/blob/5.6.0/src/main/java/fr/xephi/authme/process/login/AsynchronousLogin.java)
uses the same flag for the pre-login event's async status. Setting it false
runs on FastLogin's async caller while labeling the event synchronous, which
Bukkit rejects. Player self-registration remains disabled independently.

Java plugin downloads are separate upstream programs and retain their own licenses:
[Paper](https://github.com/PaperMC/Paper),
[FastLogin MIT](https://github.com/TuxCoding/FastLogin/blob/main/LICENSE),
[ProtocolLib GPL-2.0](https://github.com/dmulloy2/ProtocolLib/blob/master/License.txt),
[AuthMe GPL-3.0](https://github.com/AuthMe/AuthMeReloaded/blob/master/LICENSE),
and [ViaVersion GPL-3.0-or-later](https://github.com/ViaVersion/ViaVersion/blob/5.12.0/LICENSE).
Pinned URLs/checksums live in `HOST_ARTIFACTS`; the Apache service license does not
relicense downloaded plugins. Playit's pinned official source is
[BSD-2-Clause](https://github.com/playit-cloud/playit-agent/blob/3adf0fd4fb72c866511890eabb766732734f3cda/LICENSE.txt).
The Mac installer verifies its source archive and compiles with `--locked`.
No plugin or playit binary is bundled into the release archive.

The binary pin establishes executable provenance; the hosted HTTP API evolves
separately. Allocation follows the official Minecraft plugin's
[HTTP request schema](https://github.com/playit-cloud/playit-minecraft-plugin/blob/4888f44ef09c30b7fb76fc64fa2f6c0ad1adbc8a/agentkey_schema.ts):
`protocol: { type: "tunnel-type", details: "minecraft-java" }` and
`endpoint: { type: "region", details: { region: "global", port: null } }`,
with the authenticated agent origin and mandatory PROXY V2 configuration.
The pinned native client's older `ports`/`alloc` request was rejected by the
hosted API even though a fixture copied from that source passed. Keep live
redacted response goldens separate from simulated scenarios: agreement with
an old source shape does not establish hosted API acceptance.

The isolated compatibility check downloads the pinned real stack into a temporary
world and broker, authenticates 26.3/1.21.11 friends and the 1.21.4 bot, and
checks the premium encryption gate. Run it explicitly:

```sh
MINECRAFT_VIAVERSION_INTEGRATION=1 pnpm exec vitest run --config vitest.config.ts integrations/minecraft-mcp/test/hosting-viaversion.integration.test.ts
```

It stops and removes its fixture. A graphical vanilla client, positive premium
session and public tunnel/Discord acceptance remain separate live checks.

The focused AuthMe boundary check uses an already provisioned pinned stack's
immutable jars and bootstrap cache in a fresh world and broker. It verifies
premium account provisioning, preserved passwords, closed self-registration,
async bot/friend login and code revocation, and startup account repair:

```sh
MINECRAFT_AUTH_INTEGRATION=1 MINECRAFT_AUTH_ARTIFACTS=/path/to/provisioned-host pnpm exec vitest run --config vitest.config.ts integrations/minecraft-mcp/test/hosting-premium.integration.test.ts
```

It copies no account databases, configuration, credentials or world state.
Positive FastLogin premium auto-login still requires a real premium session.
