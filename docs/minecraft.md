# Minecraft

Clankie can join an owner-configured Java server as his own offline player,
chat, follow a player, navigate, dig, place blocks, craft inventory recipes and
build a sequence of placements. His existing conversation chooses the actions;
the service-owned MCP motor handles physics and navigation.

Owner-configured external profiles support offline protocol login. His own
Paper server supports premium-verifying hybrid authentication; a Microsoft
account for Clankie remains unnecessary. This does not prove a live
friend session or Discord call. The local manual conformance script verifies
the motor independently through Paper RCON; ordinary CI never starts a world.

## Host Clankie's own server

The Minecraft integration owns a pinned Paper **1.21.4 build 232** server, Java
process, private RCON, world backups and playit agent. Clankie's service owns
Discord authority, username bindings, auditing, destination policy and the one
play lease. The integration's hosting port separates the local Mac provider
from the optional AWS EC2 provider. Neither starts a server during catalog or
status reads.

Hosting is **off by default**. Ask Clankie to start a world when you want to play,
or use the operator CLI/TUI:

```sh
clankie minecraft host configure
clankie minecraft host start
clankie minecraft host status
clankie minecraft host admin '{"operation":"list"}'
clankie minecraft host admin '{"operation":"gamerule","rule":"keepInventory","value":true}'
clankie minecraft host backup
clankie minecraft host stop
```

Java 21 must be installed. The manager discovers an explicit Java path,
`JAVA_HOME`, Homebrew's Java 21 or `java` on PATH. Artifacts are downloaded only
for requested setup/start and verified against pinned checksums. James approved
the local server EULA on 2026-10-04. Server settings and world data live under
Clankie's data directory, in `minecraft-host/`; the standalone integration accepts
`--data-dir`. Broker credentials stay in the canonical credential store. Never
copy its private `server.properties`, plugin databases or console logs into chat.

`host configure JSON` changes integration-owned settings while stopped. Available
fields are `gamePort`, `rconPort`, `java` (an absolute Java 21 path), `memoryMiB`,
`backupIntervalMs`, `backupRetention`, `idleTimeoutMs` and `maxUptimeMs`. Defaults
are game/RCON **25684/25685**, **1024 MiB**, daily backups retained for seven runs,
**15 minutes** empty-server timeout and **6 hours** maximum requested-run uptime.
Idle timeout cannot exceed 15 minutes. Empty-server shutdown saves and backs up
before stopping; the uptime limit also applies while players are present. Crash
restarts use backoff and retain the original run deadline. An idle/watchdog stop
also stops the tunnel. A bot still connected counts as a player; maximum uptime
prevents it keeping the server alive indefinitely.

### AWS hosting and cost controls

AWS hosting manages one pre-provisioned EC2 instance through Systems Manager
(SSM). Provisioning is an operator task; gameplay tools cannot create instances,
change IAM or increase spending limits. The controller needs AWS CLI v2 and the
Session Manager plugin. The product uses its own scoped broker
credential, never the operator's administrative SSO profile. SSH and public RCON
are unnecessary. Preserve an existing volume with a snapshot before modifying an
existing server; an x86 instance cannot be resized directly to an ARM/Graviton
instance type.

Checkout provisioning helpers live in
[`integrations/minecraft-mcp/scripts/aws/`](../integrations/minecraft-mcp/scripts/aws/).
They require explicit account/instance identifiers and verify the target before
changes; deployment finishes with EC2 stopped. Cold Paper startup can take several
minutes on a small instance; the AWS guest permits up to eight minutes of Java
startup while retaining its independent boot and uptime limits.

Select the provider while the existing host is stopped. The operator supplies
the account and instance identifiers from provisioning; these are not model
inputs or credentials:

```sh
clankie minecraft host configure '{"backend":{"kind":"aws-ec2","accountId":"YOUR_ACCOUNT_ID","instanceId":"YOUR_INSTANCE_ID","region":"us-east-1"}}'
clankie minecraft host configure '{"backend":{"kind":"local"}}'
```

Clankie's bot reaches the guest's loopback Paper port through a scoped SSM port
forward, preserving the bot's source restriction and the ordinary shared play
lease. Friend invitations use the public address. Host control uses a bounded
custom SSM document; secret-bearing replies are encrypted to the requesting
adapter rather than recorded as plaintext in SSM command history.

The instance stays stopped until someone requests play. Its public IP/DNS may
change on every start; use the current ready-state invite, not a saved address.
No Elastic IP or playit tunnel is required. Public TCP ingress must preserve the
real client address through a trusted guest proxy; Paper and RCON remain bound
to loopback. The proxy opens only after authentication readiness and closes before
server transitions. Do not expose Paper's PROXY-enabled listener directly to the internet:
a client could forge its source address.

Cost protection has separate failure boundaries:

- A guest watcher checks actual player occupancy and saves, backs up and shuts
  down after 15 empty minutes. It runs independently of Clankie's service; a
  failed backup must not prevent shutdown.
- A maximum-uptime limit bounds even occupied or unhealthy runs. A guest deadline
  survives controller failure; the service also checks the requested run. The
  supplied systemd timer powers off at six hours after boot regardless of a
  longer configured application timeout.
- A CloudWatch low-CPU alarm provides an additional EC2 stop action. CPU is only a
  heuristic: low CPU does not prove there are no players, and busy idle software
  can avoid its threshold.
- A Minecraft-tagged monthly budget alerts the operator around $10. **A budget
  alert is not a hard spending cap.** Stopped instances still incur EBS and
  snapshot storage charges, and active instances may incur public IPv4, transfer
  and CPU-credit charges. Activate the resource tag for cost allocation before
  relying on the filtered budget; resource tags alone do not enable billing
  allocation. See [AWS cost allocation tags](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/cost-alloc-tags.html).

A stopped Paper process is not proof that EC2 stopped. Verify the instance state
through EC2 after every manual test, including failed starts and guardrail probes.
Live acceptance must separately establish the guest idle stop with the controller
absent, the uptime deadline, the CloudWatch stop action, budget configuration,
a premium human join and the bot join. Unit tests and an installed alarm alone
cannot establish those outcomes. Resource IDs, private account details and live
cost measurements belong in the operator's private provisioning record.

### Public tunnel and invites

Run this once to provision the pinned playit agent and claim it in your personal
playit account:

```sh
clankie minecraft host tunnel claim
```

The command displays a claim URL and waits for your browser approval, then stores
the permanent agent key in the broker. On macOS, playit has no official binary
asset for the selected version: setup compiles pinned **0.17.1** source with its
locked Cargo dependencies, so Cargo is required. Future starts use the verified
cached executable. No router forwarding is needed. Public address and genuine
remote connectivity remain unverified until an account claim and remote join.

Ask Clankie for an invite in the Discord room where you want it. He posts the
public Minecraft address/version there, with the two login paths below. The
public tunnel carries only the game port, uses mandatory PROXY V2 forwarding,
and never exposes RCON. A missing claim, unsafe tunnel configuration or failed
auth readiness refuses a usable invite. Tunnel status confirms its supervised
agent/configuration; it does not by itself prove end-to-end connectivity.

### Friends and authentication

Premium friends ask Clankie to whitelist their usual Minecraft name and join
with their normal Java launcher. Premium classification is checked against
Mojang and persisted in FastLogin before admission; those names require real
Mojang session authentication, including during a lookup outage.

Nonpremium friends ask in Discord using their Minecraft name. Clankie records
the authenticated requester, and a designated owner/admin approves that recorded
request. He DMs a random one-time code; enter **`/login <code>`** after joining.
The code expires after five minutes and rotates after authenticated login.
Request a fresh code in Discord for later joins. In-game self-registration and
IP/session remembered login are disabled. A failed or uncertain DM never exposes
the code publicly or silently reissues it; disabled DMs need resolving first.

Username ownership is case-insensitively bound to the Discord requester. In-game
names/chat cannot authorize hosting actions. An already approved Discord-bound friend may request an on-demand start; this
standing play permission grants no other administration. Server administration
requires Clankie's configured Discord owner or an individually designated machine operator;
a trusted guild/channel grant alone is insufficient. Commands cover whitelist,
kick/ban/pardon, typed gamerules, time/weather/gamemode, say/tell and player list.
There is no player `op` or arbitrary RCON command tool. All core requests are
audited in `minecraft-host/admin-audit.jsonl` without secrets.

Clankie automatically gets the reserved **`clankie-hosted`** approved profile
when the server is ready. His account is **`ClankieLocal26`**, because `Clankie`
is a registered premium name. His bot joins through loopback, supplies a trusted
local PROXY header and logs in internally from the broker. Public forwarded
sources cannot log in as that account, even with its password. AuthMe rejects
a restricted source after a brief unauthenticated spawn; its movement/chat and
inventory restrictions stay enabled. His ordinary game-chat tools never carry
the login password. Playing still requires the existing shared play lease.

The pinned plugin stack is FastLogin, ProtocolLib **5.4.0**, and AuthMe **5.6.0**.
Plugin startup or provisioning failures keep auth readiness false. FastLogin's
lookup-error defaults alone are insufficient; the persisted premium marker,
disabled in-game registration and mandatory original-IP forwarding are part of
the hosted boundary. Local tests established these paths; a premium human join,
actual public source-IP forwarding and Discord code delivery still need live
acceptance. Local subsystem tests do not prove those external paths.

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
