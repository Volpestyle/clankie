# ADR 0053: An external harness possesses Clankie under a lease

Status: accepted (James, 2026-07-25). The MCP server, the possession lease, and
the Discord ports' seams are implemented; the ports have no bridge-side
implementation yet.

## Context

Clankie plays FireRed in an agent loop ([ADR 0049](0049-free-play-agency-and-non-deterministic-evidence.md)).
A coding harness is the same loop. Publishing his body as MCP tools lets Claude
Code, Codex, or anything else drive him — and is the strongest available test of
the tool surface, because a surface an external harness can play well through is
one his own loop can.

`GbaEmulatorToolNameSchema` had specified that surface since ADR 0016 and had
zero consumers. This adds the second one.

## Decision

`apps/gba-mcp` publishes the emulator surface over MCP. It is a **consumer** of
the existing surface, not a parallel stack: tool arguments derive from the
existing action and observation schemas, every action dispatches through
`EnvironmentRuntime`, and the ROM loader is shared with the free-play CLI so
there is one path to the core and one place digests are checked.

That is what keeps ADR 0049's "changes _who decides_, not how an action is
authorised" true when the decider is an external harness: an illegal button, an
exceeded frame bound, or a missing capability is refused by the machinery that
refuses a script.

`@clankie/mcp-registry` is the _consumption_ side — Clankie's workers using
external servers under doctrine. This is the opposite direction and is a
separate package rather than an extension of it.

### The fence: a possessor holds no gateway

**This is the central finding, and a future reader will otherwise re-derive it
the hard way.**

The obvious implementation of "let the possessor speak" is a direct call to the
Clankie service's `POST /v1/discord/presence-actions`. It does not work. That
endpoint requires a **live presence claim** — the session id, phase, and
monotonic revision the Discord bridge publishes while it holds the gateway
([ADR 0024](0024-discord-dual-plane-presence.md)) — and only the bridge can mint
one. That is precisely the fence stopping an action from reaching a session that
is not live.

A possessor holds no gateway, therefore no claim, therefore cannot speak
directly. So speech and hearing are **ports**: the possessor asks the process
that owns the body in Discord to act for it. That also preserves the invariant
that possession changes who is deciding, never which account is present.

### Possession is a lease, not a second driver

Two dispatchers reaching the same core produce a character twitching between two
intents. Taking the body therefore **suspends** the resident loop rather than
racing it; arbitrating afterwards would still have let both intents land.

- Observation needs no lease. Looking is not driving, and a harness should see
  the game before deciding to take it.
- Acting, speaking, and listening require the lease.
- Stealing a live lease requires `force`, so it is an explicit act rather than
  the outcome of a race. Every transition is logged.
- Leases expire, so a crashed holder does not keep the body forever.

### A new principal class

The possessor attaches to **neither the ambient tier nor the voice presence
tier**. Possessing the body has a different consequence from summoning Clankie
into a call or starting a mission, and [ADR 0050](0050-voice-presence-authority-tier.md)
established that a different consequence gets its own named, deny-by-default
binding rather than being folded into an existing one. Unset means possession is
unavailable and only observation works.

### Hearing is push, and downstream of consent

`clankie_listen` is an egress path, so it sits downstream of
`/captain-voice-consent`: a possessor hears exactly what Clankie is already
permitted to hear, transcripts only, never raw PCM. Asking as a possessor grants
no additional access.

It is **push rather than pull, and that is a privacy constraint**. Asking the
bridge for "the last N lines" would require it to retain transcripts, and it
deliberately retains none — PCM buffers are zeroed after use and the bot does
not persist channel transcripts ([ADR 0045](0045-official-bot-dave-group-voice.md)).
A pull-shaped port would have quietly forced whoever implemented it to break
that invariant. Utterances are pushed to a live subscriber; the bounded window
lives on the possessor's side and is cleared on release, so what is heard does
not outlive the possession that heard it.

### Possession is not disclosed to the room

**Owner decision (James, 2026-07-25): no in-channel disclosure.** Possession is
visible operator-side — every lease transition is logged — and the room is not
told that a guest is driving.

This is the deployment-specific disclosure rule alongside
[ADR 0051](0051-layered-character-register-and-reply-policy.md). The boundary is
deployment-shaped rather than universal: the
lab server is private and small, its participants are known to the owner, and
they already know Clankie is a machine the owner drives. Two extra messages per
session buy nothing those particular people do not already have.

The residual risk is recorded rather than argued away. A possessor both speaks
and listens, so participants are addressed and overheard by a party they cannot
detect, and the operator-side log is accountability for the owner, not for them.
**That trade holds only while the deployment stays private and owner-known.** If
the activity is ever verified, the server opened past the people the owner can
name, or possession handed to someone other than the owner, this decision should
be revisited rather than inherited.

## Options weighed

- **Fold the server into `@clankie/mcp-registry`** — rejected. That package is
  the consumption side; producing a server is a different direction, and folding
  them would blur which way trust flows.
- **Give the MCP server its own path to the core** — rejected. It would produce a
  third definition of what Clankie can do in a game, and the fail-closed
  behaviour would have to be reimplemented rather than inherited.
- **Let both the possessor and the free-play loop drive, arbitrating on
  `goalVersion`** — rejected; see the lease section.
- **Speech as a direct Clankie service call** — rejected: the live-claim fence
  forbids it.
- **No listening seam at all** — rejected: a port interface is a seam, not a
  third capability definition, and omitting it makes the surface asymmetric.

## Consequences

- **Two locks, two jobs.** The possession lease decides which harness drives a
  running loop; a lockfile in the shared body root decides which _process_ owns
  the body at all. `EnvironmentRuntime`'s one-writer rule does not close
  the second gap: every entrypoint constructs its own runtime, so the rule is
  in-memory and invisible across processes — the MCP server and the free-play CLI
  could each hold what they believed is the only body. `acquireBodyLock` makes
  that a refusal naming the holding process, verified across two real processes.
  It expires by liveness (`kill(pid, 0)`) rather than by time, so a crash cannot
  brick the body and a long playthrough cannot be evicted mid-turn. The MCP
  server takes it **on possession, not at startup**: clients launch stdio servers
  freely, so locking at process start makes the first server win and every later
  one fail to connect at all. Looking is not driving, and the lock follows
  driving. Consequently
  the body is a **single-machine** resource; `CLANKIE_GBA_BODY_ROOT` is the
  documented way to run a second, separate body.
- Both Discord ports refuse by default with errors naming what is missing.
  Implementing them is a change in `apps/discord-bridge`, the process holding the
  live claim and the consent registry.
- The ports reach Discord over a loopback, token-gated control channel dialled
  outward from the MCP server, so the credential-holding process opens no
  inbound port. This reuses the activity plane's frame-producer shape
  ([ADR 0047](0047-discord-activity-presence-plane.md)) rather than introducing a
  second bespoke transport.
- A possessor does not inherit Clankie's persona and does not need to: the body,
  account, and bounds are his, the decisions are the possessor's. Gameplay is
  unaffected by this — a button press has no voice — but `clankie_say` reaches
  third parties, so a possessor speaking reads as Clankie's account carrying the
  possessor's voice. If a run should sound like him, that is a reason to let his
  own loop drive.
