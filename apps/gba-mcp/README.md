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

| Tool                        | What it does                                                            |
| --------------------------- | ----------------------------------------------------------------------- |
| `gba_emulator_observe`      | Decoded state **and the rendered screen as an image**                   |
| `gba_emulator_start_action` | One catalogued action; a short tap only turns, 16 frames commits a step |
| `gba_emulator_pause`        | Stop for a stated reason when the state looks uncertain                 |

Observation returns the frame because the decoded state is a privileged, partial
view: it carries position and facing but not what is _in_ the room. A caller that
reads only RAM discovers furniture by walking into it.

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
- `onHeldChange` suspends and resumes a co-hosted loop on take and release —
  suspension rather than arbitration after the fact, because arbitrating later
  would still have let two intents reach the core.

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

One consequence worth knowing rather than discovering. Gameplay is unaffected —
a button press has no voice. But `clankie_say` is visible to third parties, so a
possessor speaking in the channel reads as **Clankie's account carrying the
possessor's voice**. That is accepted, not overlooked: if a run should sound like
him, that is a reason to let his own loop drive rather than a reason to bolt a
persona onto the possessor.

**Possession is not announced in the channel** (owner decision, ADR 0053). It is
visible operator-side — every lease transition is logged — and the room is not
told a guest is driving. That trade rests on the deployment being private and
its participants known to the owner, and ADR 0053 records the trigger for
revisiting it.

## One body, one process

The possession lease decides which harness drives a running loop. A separate
lockfile decides which *process* owns the body at all, because the two questions
have different answers: the lease is in-memory and a second process has its own
memory.

Every entrypoint resolves the same body root, but they take `body.lock` at
different moments. A loop that starts driving immediately takes it at startup.
**This server does not** — it takes the lock when someone *possesses* him, and
releases it on release.

That distinction is load-bearing. An MCP client starts stdio servers freely:
`claude mcp list`, every session, every retry. Locking at process start meant the
first server won the body and every later one died with `BodyBusyError` before it
could serve a single tool call — contention over *existing*, not over the body.
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
