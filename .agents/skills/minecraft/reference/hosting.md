# Minecraft hosting details

Backend setup and the managed server stack behind [the skill](../SKILL.md).
Checkout setup and limitations: [`docs/minecraft.md`](../../../../docs/minecraft.md).

## This computer (local backend)

Read `minecraft_host_configuration` and host status; while stopped, use
`minecraft_host_configure` with `settings: {backend: {kind: "local"}}`. Java 21
and, on macOS, Cargo for the pinned playit build must be available.
`minecraft_host_claim` starts the claim without a terminal and returns
`preparing` while the pinned agent builds in the background. Poll
`minecraft_host_claim_status` for `pending` and the account claim URL, which the
owner approves in their browser. The integration polls playit every three
seconds and stores the approved agent secret in the broker automatically, even
after the caller exits; `minecraft_host_claim_complete` also reads status.
Resolve expired or rejected claims before starting.

A claimed account still needs tunnel allocation. Start registers the claimed
pinned agent with playit before requesting its first tunnel; initial
registration can take a short time.

- `playit-agent-version-too-old`: playit has not accepted the agent version.
- `playit-api-invalid-request`: an integration/API compatibility failure.
  Neither is evidence that the owner needs a paid plan or another claim.
- `playit-email-verification-required`: tell the owner to verify their playit
  account email, then retry start.
- Other safe `tunnel.error` codes describe a failed public connection even when
  Paper is running and auth-ready.
- `playit-tunnel-allocation-pending`: an uncertain allocation with no visible
  tunnel. Interrupted allocation reconciles on the next start, and a confirmed
  rejection can retry creation. Never delete its marker or create an extra
  tunnel to bypass it.

Local hosting needs a ready playit tunnel.

## AWS backend

While stopped, select `settings: {backend: {kind: "aws-ec2", accountId,
instanceId, region}}` with owner-supplied identifiers. Required groundwork is an
SSM-managed guest, trusted source-IP proxy, private Paper/RCON, independent
idle/uptime shutdown, EC2 stop fallback and the roughly $10/month budget alert. The checkout
helpers in `integrations/minecraft-mcp/scripts/aws/` prepare an existing
instance; they do not create one, and guided provisioning does not exist yet.
AWS provisioning and budget changes are operator work, outside gameplay tools.
Use only the configured instance through its scoped broker credential; its
address may change on each start. Guest idle/max-uptime controls must remain
active independently of this service. A CloudWatch low-CPU alarm is a fallback
heuristic. Spot prices can change and interruption is possible; an hour of play
can also include public IPv4, transfer or CPU credits and the share of
EBS/snapshots that continues while stopped.

## An existing server

Obtain the owner's host, port, supported Java version and a non-premium bot
username. Read `minecraft_configuration`, then submit the full settings with
`minecraft_configure`: the new offline profile and any specifically approved
public endpoint. Profiles carry `id`, `name`, `host`, `port`, `version`,
`username`, `auth: "offline"`. Public SRV redirects also need the resolved
target/port approved. External profiles do not support supplying an AuthMe
password; do not send one through game chat. Offer the managed hybrid setup, or
an owner-approved private offline server, when the existing server can't host
this bot.

## Managed hybrid stack

On the selected managed local/AWS backend, the first requested start provisions
the pinned Paper 1.21.4 build 232 with FastLogin, ProtocolLib 5.4.0, AuthMe 5.6.0
and ViaVersion 5.12.0. Clients from 1.21.4 through 26.3 may join; the bot and
viewer stay on 1.21.4. Use the status-supported client list in invites.

The manager sets offline-mode **with** whitelist, forced premium classification,
no in-game registration or remembered IP sessions, restricted bot login, trusted
original-IP forwarding and loopback-only Paper/RCON. Those settings belong to the
manager, not a copied plugin recipe; server/plugin readiness gates invites. An
existing world needs a separate owner-approved backup/migration before any
manager replaces its configuration; there is no automatic world import command.

Premium enrollment prepares both the FastLogin premium marker and the AuthMe
account before whitelist admission. An AuthMe registration prompt for an approved
premium name is a provisioning failure to resolve through owner-approved
enrollment. Startup repairs missing AuthMe accounts only for existing
whitelisted names already persisted as premium; it does not enroll or whitelist
new names. Keep player self-registration disabled. `premiumUuid: false` preserves
the world's player identity while FastLogin still verifies the premium Mojang
session. Keep AuthMe's `settings.useAsyncTasks: true`: FastLogin's automatic
login depends on it.

## Play loop and capture

`play` settings are enabled, model, maxTokens/maxCostUsd, turnIntervalMs,
idleBackoffMs and idleStopMs. Model, budget and pacing apply to the next mind
run; disabling quiesces the current run. Pokémon and Minecraft share a
turn-based kernel but keep their native actions and verification. In a source
checkout the offline journal evaluator also reads Minecraft sittings
(`pnpm --filter @clankie/play gameplay:evaluate-journal <journal.jsonl>`);
Pokémon tile/scene verdicts read unknown for them.

An uncertain stay blocks extension removal and reuse until core proves the exact
connector end; a requested stop, lost adapter or deadline is not termination
evidence. Viewer capture polls the motor only during an owned stay (including
unresolved recovery), never just because profiles are configured; a new join
resumes capture within 500 ms.
