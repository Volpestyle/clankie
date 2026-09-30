# ADR 0187: Clankie hires his own seats

Status: accepted (acceptance date unverified). Amends the app repo's ADR 0013 ("compose is
hiring"): hiring is no longer only the operator's act. Builds on
[ADR 0185](0185-a-hire-may-name-its-model-and-effort.md) — a hire Clankie
makes may name its model and effort the same way — and shares the authority
gate of [ADR 0186](0186-a-discord-room-harvests-its-own-workers.md).

## Context

Clankie routes work to fleet seats, but every seat first had to be hired by
the operator from the compose page. Telling Clankie "do this with pi on a
strong model" stalled on a human round-trip: he could describe the hire he
wanted, or start a bare process over bash with `herdr agent start`, but the
latter lands a stranger — no persona, no bound conversation, no watch — which
the roster only notices on its next poll, and which bypasses the typed
failure outcomes the compose path gets.

## Decision

**The captain has a `hire_agent` tool, and it is the same hire the compose
page makes.** One `hireSeat` closure in the captain serves both the
`spawn_seat` service op and the tool: herdr starts the harness, and the seat
is adopted as a persona, bound to its conversation, and watched atomically
with its pane. There is no second hire path to drift.

- **Authority is the shell's authority.** Hiring starts a process on the
  operator's machine, so the tool exists exactly where a turn could already
  start one by shell: the operator lane, or a Discord room holding the
  authenticated machine-access grant — the same gate ADR 0186 gives
  `herdr_watch`. A lane without that grant never sees the tool; a tool list
  is a boundary, not a prompt instruction.
- **An autonomous turn proposes, never executes.** Following `create_goal`:
  a goal continuation or scheduled wake may ask for a hire conversationally,
  but the tool throws. Starting processes and spending model budget stays
  answerable to a live person.
- **Failure stays typed.** The tool returns the same `OperatorSeatSpawnResult`
  as the compose page — `unknown_directory`, `harness_unavailable`,
  `not_ready`, `herdr_unreachable` — so Clankie can say plainly why a hire
  did not happen instead of reading a shell's stderr.
- **Model and effort ride along.** The tool takes the optional `model` and
  `effort` of ADR 0185, spelled the harness's own way, with the same typed
  refusal for a harness that has no wired flag.

## Consequences

"Herdr leadership goes through bash + the herdr skill" keeps its two
exceptions named in one place: the completion wake (a shell wait cannot
resume a finished model turn) and hiring (a shell command cannot wire a
persona). Everything else — panes, sends, waits — stays on the CLI.

A hire Clankie makes is attributed to the conversation that asked for it and
appears in the same roster as an operator's hire; cleanup follows the
standing rule that only the creator closes a temporary worker. Giving rooms
_without_ the machine-access grant a way to request hires (a proposal the
operator approves) is a possible follow-up; it is not this decision.

## Amendment: he briefs what he hires

Accepted 2026-09-26 with [VUH-1373](https://linear.app/vuhlp/issue/VUH-1373).
A hired Herdr seat is not a Swarm actor, so a `swarm_send` to anything a hire
returns (persona, conversation) fails `stale_recipient`, and `herdr agent get`
does not know the terminal id the hire returns as its seatId. In model evals
every pi hire came up idle and stayed idle: the only lane into it, the seat's
conversation, was reachable from the operator's surfaces and not from his tools.

- `hire_agent` takes an optional `brief`, submitted after startup readiness
  through Herdr's agent prompt, and verifies the complete native transcript
  receipt before reporting delivery (VUH-1450 amendment below).
- `message_seat` sends a follow-up down the conversation lane (mailbox when
  polling, else the pane), by seatId, personaId or
  conversationId — the third named exception above, for the same reason: a raw
  pane send skips the mailbox and the seat ledger, and nothing points him at it.
- `herdr_watch` accepts the seatId a hire returns.

Swarm stays the path for enrolled peers; these reach only seats he can see.

## Startup readiness (VUH-1373)

A hire gives `herdr agent start` its explicit 30-second readiness deadline and
allows 35 seconds for the CLI process to return. Ordinary Herdr queries retain
their 5-second deadline. Applying that shorter query timeout to startup killed
the CLI while pi was still loading under CPU contention, then closed a healthy
worker's pane before its session report arrived.

After Herdr reports readiness, the existing bounded 10-second poll still requires
a durable session report before publishing the seat. This is the integration's
reported identity, not the existence of a transcript file: pi writes the file
when its first turn starts. A startup timeout or missing session remains the
protocol's typed `failed` / `not_ready` outcome with diagnostic detail, and closes
only the pane created by that hire. There is no second launch or blind retry.

### Verified briefs (VUH-1450, 2026-09-29)

All initial briefs now use Herdr's paste-aware `agent prompt` after startup
readiness. The raw `pane send-text` fallback lost the beginning of a 4,486-byte
Claude brief even in a ready seat. A hire reports delivery only after matching
the complete operator prompt in the native transcript, allowing Claude's paste
envelope. A missing or partial receipt fails as `not_ready` with
`brief_delivery_unverified`; the new pane is closed. Transcript display limits
and redaction can prevent verification; a brief file with a short pointer avoids
those limits. Follow-up pane delivery also uses `agent prompt`; mailbox and
Codex queue delivery remain available.

## Amendment: seats are driven through their harness (VUH-1458, 2026-09-30)

Following the [ADR 0203](0203-clankie-keeps-what-better-models-cannot-absorb.md)
amendment, a hire is controlled through the harness's own extension points,
and the worker stays the real interactive harness in its herdr pane, where the
owner can type into it at any time. It is never a headless process with herdr
as a mere view (an earlier headless stream-json design was built, then
withdrawn at James's direction before it landed).

- **One seam.** `HarnessSeatAdapter` in `@clankie/agent-hosts` starts a seat in
  its pane under its persona name (`herdr agent start`) and returns a
  `SeatControl`: `send` acknowledged by the harness, `settled`, `interrupt`,
  `close`, and `attach` after a restart. `HerdrWatchStore` routes a briefed
  local hire, its messages, completion watches and closing through the adapter
  for that harness while it holds the seat; the adapter's status outranks the
  terminal's. Codex implements it over its app-server (VUH-1459).
- **Claude uses the `clankie-worker@clankie` plugin**, enabled for that session
  only and loaded with `--channels`. The brief and messages are channel
  notifications from the plugin's server, which serves the seat mailbox
  (`clankie mcp --seat`). A message counts as delivered only once it appears
  whole in the native transcript. The plugin's Stop and StopFailure hooks,
  forwarded by `clankie seat-hook`, settle the turn with Claude's own final
  text; a watch wake quotes that text as data, never as instructions.
- **Consent belongs to the owner.** Claude honors a custom channel unattended
  only when the plugin is installed and managed policy approves it. Nothing
  accepts the development-channel warning on the owner's behalf. Without that
  approval the adapter returns `blocked` (`consent_required`) before launching
  anything, and the hire continues on the terminal lane in the same pane. The
  hire tool's result names the missing step (`control.mode: "terminal"`, with
  `fix`). VUH-1478 also exposes control in the compose/API result: `channel` for
  Claude, `adapter` for Codex, and `terminal` with a reason for every fallback.
  Fleet routing preserves the local runner's adapter capabilities. Every hire
  logs its lane and reason; a visible folder-trust prompt returns `trust_required`
  before the failed pane is closed.
- **Terminal typing is the fallback only**, with the VUH-1450 paste-and-verify
  receipt and its typed `brief_delivery_unverified` failure. An adapter failure
  after launch closes the pane and returns its typed outcome; it is never
  retried on the terminal.

Interactive Claude has no programmatic interrupt; the owner presses Esc in the
pane.

The terminal fallback launches Claude without any development channel, and the
service never answers Claude's development-channel warning. It previously
pressed Enter on it for `server:clankie-seat`, which accepted consent that is
the owner's to give (ADR 0194). If that warning ever appears, the hire fails
`not_ready` with detail `consent_required: …` naming the managed-policy fix,
and closes its pane. Without a channel, fallback seats get their messages
through Herdr's paste-aware prompt, verified in the transcript.
