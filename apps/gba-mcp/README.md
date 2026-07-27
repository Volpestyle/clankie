# Clankie's GBA body, as an MCP server

Architecture record: [ADR 0053](../../docs/adr/0053-mcp-possession-of-clankies-body.md).
This file is the operating guide; the decisions and their reasoning live there.

Publishes the emulator surface over MCP so any harness — Claude Code, Codex,
anything that speaks the protocol — can play Clankie's FireRed.

This is also the strongest test of the tool surface itself: if an external
harness plays well through these tools, Clankie's own loop can.

## Not a second body

Three things make this a _consumer_ of the existing surface rather than a
parallel stack:

- Tool names and arguments derive from `GbaEmulatorToolNameSchema` and the
  action/observation schemas in `@clankie/interactive-environment`. Nothing here
  invents a capability.
- Every action dispatches through `EnvironmentRuntime`, so a possessor is bound
  by the same lease, idempotency, and fail-closed limits a script is. This is
  what keeps [ADR 0049](../../docs/adr/0049-free-play-agency-and-non-deterministic-evidence.md)'s
  "changes who decides, not how an action is authorised" true when the decider
  is an external harness.
- The ROM/scenario loader is shared with the free-play CLI, so there is one path
  to the core and one place digests are checked.

`@clankie/mcp-registry` is the _consumption_ side — Clankie's workers using
external servers under doctrine. This is the opposite direction and is
deliberately a separate package.

## Running it

```bash
pnpm --filter @clankie/gba-mcp start          # stdio
pnpm --filter @clankie/gba-mcp probe          # drive it like a harness
```

ROM-gated exactly like free play: with `CLANKIE_GBA_ROM_PATH` and
`CLANKIE_GBA_SAVESTATE_PATH` this is the real game behind the pinned core;
without them it is the clearly-labeled deterministic double.

`stdout` is the transport, so the server logs readiness to `stderr` only.

## Tools

| Tool                        | What it does                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `gba_emulator_observe`      | Decoded state **and the rendered screen as an image**                                 |
| `gba_emulator_start_action` | One catalogued action: a button press, `walk_to`, `advance_dialog`, or `enter_text`   |
| `gba_emulator_pause`        | Stop for a stated reason when the state looks uncertain                               |
| `gba_emulator_resume`       | Undo a pause. Pausing is safe from anyone; resuming is driving, so it needs the lease |

Observation returns the frame because the decoded state is a privileged, partial
view: it carries position and facing but not what is _in_ the room.

It also carries `surroundings` — whether each neighbouring tile and the tile
being faced is passable, read from the map's own collision
([ADR 0058](../../docs/adr/0058-read-collision-from-the-live-map-buffer.md)).
Without that a caller does tile arithmetic on the PNG to guess what is solid, and
discovers furniture by walking into it.

### Moving

A short directional tap only turns; 16 frames commits a step. For anything
further than one tile, prefer `walk_to` with a target `x`/`y`: it plans around
walls using real collision, re-checks every step because collision does not
include NPCs, and reports `blockedAt` if the route stops being true.

`walk_to` moves **within** a map. Doors and staircases carry blocking collision
and transport anyway, so no collision-planned route can step onto one — walk to
the tile beside the stairs, then press into them.

Every action result carries the state it produced — `position`, `facing`,
`moved`, `turned`, `surroundings`, and any visible `dialogLines`/`menu` — so a
move needs no follow-up observe. `moved` is the one that matters: a press into a
wall completes, and changes the RAM digest, because the bump animation is itself
a state change.

### Talking

`advance_dialog` reads an open conversation to its next real decision point in
one action ([ADR 0066](../../docs/adr/0066-dialog-is-one-action-not-one-press-per-box.md)).
It presses only when the game is holding a box for an advance, waits on frames
rather than inputs while text is still printing, and returns a `transcript` of
every box it read.

It stops — and says which in `endedBecause` — when the dialog closes, a choice
opens, a battle starts, or the budget runs out. It never answers a choice: the
menu comes back in the outcome so the next action is the decision. Prefer it to
`repeat`-mashing A, which cannot see the box close and re-engages the NPC.

A script-held box (a fanfare holding the screen with controls locked) is waited
out rather than refused, and battle text reads like dialog, stopping at the
action menu ([ADR 0072](../../docs/adr/0072-the-harness-tells-him-the-truth.md)).

Text speed is an in-game Option. Setting it to FAST once and minting a
checkpoint makes every later session read faster.

### Naming

`enter_text` types a whole name on the open naming screen — cursor navigation,
page switches, and the OK confirm — in one action, verifying every press
against the decoded keyboard state. Typed text that matches the requested name
is kept, a mismatch is erased first, so repeating the action resumes a
budget-interrupted entry. `submit: false` leaves the screen open.

## Fail-closed, at two layers

Verified by `probe`:

```
refusal:          MCP error -32602: Input validation error …   (protocol schema)
emulator refusal: invalid_action: frames                        (catalogue bound)
```

An uncatalogued button never reaches the core, and a frame count past the
session bound is refused with its reason rather than clamped.

## Possession

One mind drives the body at a time. An external harness is a **holder of a
revocable lease**, not a second concurrent driver — letting both it and the
free-play loop dispatch would produce a character twitching between two intents.

```bash
CLANKIE_GBA_POSSESSION_HOLDERS=codex-lab,claude-lab   # unset means possession is OFF
```

- **Observation needs no lease.** Looking is not driving, and a harness should be
  able to see the game before deciding to take it.
- **Acting requires the lease**, passed as `possessionToken`.
- **Stealing a live lease requires `force`**, so it is an explicit act rather
  than the outcome of a race. Every transition is logged to stderr.
- **Leases expire**, so a crashed holder does not keep the body forever.
- **Acting renews the lease**, so expiry bounds how long an _idle_ possessor
  keeps the body from the resident loop — never how long a session of play may
  last.
- `onHeldChange` suspends and resumes a co-hosted loop on take and release —
  suspension rather than arbitration after the fact, because arbitrating later
  would still have let two intents reach the core.

A lapse is recoverable, and that is a design property rather than luck
([ADR 0059](../../docs/adr/0059-lease-expiry-pauses-the-body.md)). A possessor
thinks between moves — that is the normal shape of harness-driven play — and
when thinking outlives the environment lease, the runtime pauses the body in
place instead of destroying the session. The next action renews the claim and
continues from the same tile; possess again if the possession lease lapsed too.
Only revocation is final: an emergency stop or explicit stop is never
resurrected by renewal.

The possessor is a **new principal class** (`mcp_possessor`), deliberately not
the ambient tier and not the voice tier: possessing the body has a different
consequence from summoning Clankie into a call, and
[ADR 0050](../../docs/adr/0050-voice-presence-authority-tier.md) set the
precedent that a different consequence gets its own named, deny-by-default
binding.

Verified end to end against a live server:

```
act:                    ERROR possession_lease_not_held     (deny-by-default)
possess:                granted (…)
act while possessing:   accepted
unnamed holder:         possession_holder_not_allowed
act after release:      possession_lease_not_held
```

## Watching an agent play

`gba_emulator_observe` returns the frame to its _caller_, which means an
agent-driven session is otherwise visible only to the agent. The server also
publishes frames to the activity surface, so a person can watch:

```bash
clankie restart activity      # or `clankie restart` for everything
```

Then open `http://127.0.0.1:4320`, or launch it as a Discord activity in the
voice channel Clankie is in ([ADR 0047](../../docs/adr/0047-discord-activity-presence-plane.md)) —
it is the same app either way.

Publishing is optional and best-effort: with no activity server running there is
no producer credential, the server says so on stderr, and play continues
unwatched rather than failing.

The frames alone show what happened, never why. A possessor can carry one short
`monologue` line on `gba_emulator_start_action` and it appears in the watch
page's sidebar, exactly where the resident free-play mind's turns land. It rides
the action call instead of being its own tool so a thought never costs an extra
round-trip, and it is gated by the same lease as the action carrying it — only
the holder puts words on the surface, under the overlay schema's length and
count caps (ADR 0049's bounded-model-text rule).

## Saving and loading progress

Progress outlives the process as **minted checkpoints**
([ADR 0060](../../docs/adr/0060-progress-as-minted-checkpoints.md)), never a
mutation of the pinned identity. `gba_emulator_save_state` captures the full
game state into an operator-local directory (`CLANKIE_GBA_CHECKPOINT_DIR`, or
`~/.local/state/clankie/gba-checkpoints`) with a receipt and a companion
scenario pinning the new digest. `gba_emulator_load_state` restores one into
the running game after verifying every digest, and lists what exists when
called without an id. Both require the possession lease: saving captures more
than observation exposes, and loading rewrites the body's whole world.

To boot a later session from a checkpoint instead of the bedroom, point
`CLANKIE_GBA_SAVESTATE_PATH` at its `savestate.ss1` and
`CLANKIE_GBA_SCENARIO_PATH` at its `scenario.json` — the same fail-closed
loader, aimed at the minted identity. Checkpoints are unavailable on the
deterministic core double, whose determinism is its identity.

## Discord reach: speaking and listening

`clankie_say` and `clankie_listen` extend possession into the channel. Both
require the lease — talking and eavesdropping as him are driving him — and both
go through a **port**, because the same fence blocks them.

### Speaking as Clankie

`clankie_say` speaks in the channel Clankie is present in, and requires the
possession lease — talking as him is driving him. The caller cannot choose the
audience: a possessor drives the character, it does not pick new rooms.

**A possessor cannot speak directly, and that is a fence rather than an
oversight.** The control plane's presence action requires a _live presence
claim_ — the session id, phase, and monotonic revision the Discord bridge
publishes while it holds the gateway ([ADR 0024](../../docs/adr/0024-discord-dual-plane-presence.md)).
Only the bridge can mint one, which is exactly what stops an action reaching a
session that is not live. A possessor holds no gateway, so it holds no claim.

So speech goes through a port: the possessor asks the process that owns the body
in Discord to speak for it. That also keeps the invariant intact — possession
changes who is deciding, never which account is present. Clankie stays the bot in
the channel.

`ClankieSpeechPort` is that seam, and it is **denied by default** with a reason:

```
clankie_speech_unavailable: no speech port is wired. A possessor cannot speak
directly — the control plane's presence action requires a live claim only the
Discord bridge can mint.
```

`@clankie/possessor-voice` is the implementation that satisfies it
([ADR 0064](../../docs/adr/0064-possessor-voice-seam.md)). It resolves the
broker-minted `clankie_possessor_voice` bearer and dials the bridge's loopback
listener; with no credential, no bridge, or no live voice session, the refusal
above stands and play simply continues in silence.

**What you say is an event, not a script.** The text is seeded into his live
realtime session as context and never spoken verbatim — report what the body
just did (`"walked into a wall by the lab"`) and he composes the line himself,
in his own voice, folded in with whatever the room is saying. Responses are
rate-limited (12 s by default) while seeding is not, so a play loop that reports
every step keeps him informed without turning the channel into a monologue.

### Listening

`ClankieHearingPort` is symmetric and blocked by the same fence: the bridge holds
the gateway _and_ the consent registry, so a possessor cannot subscribe to voice
itself.

Consent is not re-litigated at this boundary. A possessor hears exactly what
Clankie was already permitted to hear under
[ADR 0045](../../docs/adr/0045-official-bot-dave-group-voice.md) — asking as a
possessor grants no additional access — and **raw audio never crosses**:
transcripts only.

**Hearing is push, not pull, and that is a privacy constraint.** The obvious
shape — "give me the last N lines" — would require the bridge to retain
transcripts, and it deliberately retains none: PCM buffers are zeroed after use
and the bot does not persist channel transcripts. A pull-shaped port would have
quietly forced whoever implemented it to break that.

So the bridge pushes each utterance to a live subscriber and keeps nothing.
`PossessorHearing` holds a small bounded window on the _possessor's_ side, and
`gba_emulator_release` clears it: what was heard does not outlive the possession
that heard it. Subscription is lazy, so a possessor that never calls
`clankie_listen` causes no capture at all.

## How the ports actually reach Discord

Claude Code never talks to Discord. The bridge already holds the gateway — it is
the Discord-facing process — so the ports are a **local control channel between
two Clankie processes**, not a new inbound integration:

```
harness → MCP server → (loopback, token-gated) → bridge → Discord
```

The direction matters: the MCP server dials _out_ to the bridge, so the process
holding Discord credentials opens no port for anything else to connect into.
That is the same shape as the activity plane's frame producer in
[`apps/discord-activity`](../discord-activity/README.md) — loopback listener,
broker-minted bearer, deny-by-default — and reusing it means one pattern rather
than a second bespoke transport.

## A possessor is itself, not Clankie

**Owner decision (James, 2026-07-25): a harness possessing Clankie does not
inherit his personality, and does not need to.**

Possession means another mind is driving. The body is Clankie's, the account is
Clankie's, the bounds are Clankie's — but the decisions are the possessor's, and
pretending a Codex session _is_ Clankie would be the confusing story, not the
honest one. This also removes a coupling: the MCP server needs no persona
plumbing, and the persona work stays scoped to Clankie's own free-play loop.

Gameplay is unaffected — a button press has no voice. Speech is where the
distinction needed a decision, and
[ADR 0064](../../docs/adr/0064-possessor-voice-seam.md) makes it: the possessor
supplies the **event**, the persona supplies the **words**. A report crosses the
seam as context for his live voice session, so what third parties hear is
Clankie's account carrying _Clankie's_ voice, describing what a guest driver
just did. The possessor still needs no persona plumbing — it never composes a
line — and a run that should sound like him now does, without one.

The trade this accepts is the mirror image: a possessor **cannot** make him say
a specific sentence. Anything needing verbatim output belongs on the
presence-action path with a live claim, not here.

**Possession is not announced in the channel** (owner decision, ADR 0053). It is
visible operator-side — every lease transition (acquired, released, expired,
stolen, refused) writes the server's stderr **and** appends durably to
`possession-events.jsonl` beside `body.lock` in the shared body root
([ADR 0068](../../docs/adr/0068-a-playthrough-leaves-a-durable-trail.md)), so
who held the body survives the process that granted it — and the room is not
told a guest is driving. That trade rests on the deployment being private and
its participants known to the owner, and ADR 0053 records the trigger for
revisiting it.

## One body, one process

The possession lease decides which harness drives a running loop. A separate
lockfile decides which _process_ owns the body at all, because the two questions
have different answers: the lease is in-memory and a second process has its own
memory.

Every entrypoint resolves the same body root, but they take `body.lock` at
different moments. A loop that starts driving immediately takes it at startup.
**This server does not** — it takes the lock when someone _possesses_ him, and
releases it on release.

That distinction is load-bearing. An MCP client starts stdio servers freely:
`claude mcp list`, every session, every retry. Locking at process start meant the
first server won the body and every later one died with `BodyBusyError` before it
could serve a single tool call — contention over _existing_, not over the body.
Observation is not driving, so several servers can now coexist and look, while
only one of them can ever act.
A second one is refused with the holder's name and pid:

```text
Clankie's body is already held by free-play-live (pid 47221, since …).
Stop that process, or set CLANKIE_GBA_BODY_ROOT to drive a separate body.
```

The lock expires by **liveness**, not by time: a holder whose process is gone is
reclaimed, so a crash cannot brick the body, and a long playthrough is never
evicted mid-turn by a timeout. `kill(pid, 0)` is a single-machine check, which is
the same boundary the emulator already has. `CLANKIE_GBA_BODY_ROOT` points a
process at a different body when you genuinely want two.
