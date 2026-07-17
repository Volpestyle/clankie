# Eve captain

This is the lead-agent runtime. Eve supplies durable sessions, filesystem-authored instructions, tools, skills, channels, and bounded subagents. Clankie keeps mission scheduling, action policy, runner state, and the versioned event protocol outside Eve so clients and workers are not coupled to a beta framework API.

The only authored tools call a narrow control-plane API. They do not expose a generic application-runtime shell or raw credentials.

`add_recovery` proposes exactly one debugger plus read-only re-verifier pair for
an observed verification failure. The tool supplies task intent and scope only;
the control plane derives the authoritative diagnosis, failed evidence, check
identities, lineage, and resolution state from its durable mission projection.

The service resolves the captain model dynamically from layered Clankie config
through `@clankie/model-provider`. Provider credentials remain behind the local
credential broker; the TUI sees only Eve session events. The built-in Eve
shell, filesystem, and web tools are explicitly disabled, leaving the authored
mission tools plus framework coordination primitives.

Run the headless service directly when developing the TUI without the
`clankie` launcher:

```bash
pnpm --filter @clankie/captain-eve exec eve build
pnpm --filter @clankie/captain-eve exec eve start --host 127.0.0.1 --port 4321
CLANKIE_CAPTAIN_URL=http://127.0.0.1:4321 pnpm --filter @clankie/tui dev
```

Use `eve dev --no-ui` only while editing the authored captain itself. The shared
operator service uses built output so a process restart never leaves a durable
session pointing at a pruned development snapshot.

Eve owns durable conversation execution, replay, and compaction. Clients store
only their continuation/session cursor. Mission state remains authoritative in
the control plane.

The Linear channel uses the same canonical `/eve/v1/session` and replayable NDJSON stream. The control plane owns the cursor per workspace/session and supplies ambient Linear identity plus the trusted tracker thread as `clientContext`; the bridge supplies only the human trigger and correlation identities. A final non-tool `message.completed` maps to a Linear response. An `input.requested` maps to `waiting_user`; the bridge converts it to an elicitation unless its structured options identify a tool approval or its prose is approval-shaped. Approval cursors are abandoned rather than exposed to later Linear text.

## Session context and accounting

The captain keeps the private transcript in Eve's durable workflow state and
projects only redacted lifecycle and token metadata into the v2 SQLite event
store. The database is namespaced by the repository's root commit, lives under
`${XDG_STATE_HOME:-~/.local/state}/clankie/captain-sessions/`, and is protected
by a mode-0700 directory and mode-0600 database file. Continuation tokens,
prompts, model text, reasoning text, and tool inputs/outputs are never written
to this projection.

```mermaid
flowchart LR
  T[TUI cursor<br/>session · continuation · generation] --> E[Eve durable session]
  E --> H[Private history]
  E --> P[Bounded recent<br/>tool exchanges]
  E --> C[Summarize + prune compaction]
  P --> C
  E --> K[Redacted accounting hook]
  K --> S[(Hash-chained SQLite events<br/>root-commit project id)]
  R[Model registry<br/>context · max output] --> B[Usable-window policy]
  B --> C
  B --> S
```

For each selected model:

```text
reserved = min(20_000, maxOutput)
usable   = context - reserved
compact  when inputTokens >= usable
```

An absent or zero output limit reserves 20,000 tokens instead of silently
reserving nothing. Eve receives a one-token-lower compaction window because
its threshold comparison is strict `>`; integer provider counts therefore
trigger at `inputTokens >= usable`. Eve performs a dedicated summary call,
preserves the checkpoint and recent conversational tail, and removes tool calls
and results from the compacted history. Captain action hooks retain a contiguous
20,000-token tail of complete call/result pairs in Eve's private durable session
state, always keeping the newest pair. The selected-model middleware restores
only pairs missing from the provider prompt, so both the summary call and the
following continuation see recent tool results without duplicating ordinary
uncompacted history. Older tool exchanges prune at the same private boundary;
raw tool data never enters the Clankie accounting projection.

The accounting projection records compaction requested/completed checkpoints
and idempotently totals `input`, `output`, `reasoning`, and
`cache.{read,write}` across restart replay. Eve can replay an authored hook
without exposing its original stream timestamp. In that case, the stable event
key and payload identify the accounting fact and the ledger preserves the first
committed timestamp; conflicting payload reuse remains an error. Eve's current
step event does not expose reasoning tokens, so that axis remains zero unless a
future additive event field supplies it; the captain does not guess.

The operator status bar continues to compute live context percentage against
the registry's full `limit.context`, not the smaller usable compaction window.
The TUI cursor and build-generation compatibility behavior from ADR 0014 remain
unchanged.

## Restart continuity drill

The restart drill runs a built captain on an ephemeral loopback port with an
isolated workflow world and `XDG_STATE_HOME`. A deterministic delayed model
creates a real in-flight step; the drill sends `SIGKILL` to the process group,
starts the same build over the same private state, replays from cursor zero, and
submits a follow-up with the recovered continuation token. It also reopens the
SQLite projection to require a valid hash chain and nonzero replay-safe usage.

```bash
pnpm --filter @clankie/captain-eve drill:restart -- /tmp/captain-restart-drill.json
```

Eve's production inline-ownership lease is 860 seconds. The drill sets the same
lease expiry path to one second so takeover is observable promptly; it does not
bypass durable queue recovery. The evidence artifact contains event types,
hashes, exit signals, and redacted accounting only. The temporary raw workflow
state is removed after the run unless `CAPTAIN_RESTART_DRILL_KEEP_STATE=1` is
set for local debugging.

## Captain presence

The captain reports a process-scoped lease and typed Eve lifecycle facts to the
captain-authenticated control-plane presence boundary. The control plane owns
lease expiry, so a killed captain becomes an explicit Tier-1 `offline` event
within one lease window instead of disappearing silently. Heartbeat requests
renew every five seconds; the semantic log records them sparsely.

`turn.started` reports Tier-0 `working`. A parked operator question reports
`waiting_user` with a bounded generic summary and clears on its structured
action result. A session parked with live mission/subagent dependencies reports
`waiting_dependency`; otherwise it reports `idle`. The hook never persists the
question prompt, approval payload, model text, transcript, or reasoning.

```mermaid
flowchart LR
  E[Eve lifecycle hook] -->|captain token| P[POST /v1/captain/presence]
  P --> L[Control-plane lease owner]
  L --> S[(Authoritative semantic event store)]
  L -->|lease expiry| O[captain.presence.offline]
  S --> R[Status resolver]
  R --> G[Garden captain + attention]
```

## Conversation-scoped captain lanes

Operator conversations, Discord voice/presence, and gameplay use independent
durable Eve sessions. Operator sessions are keyed by server-owned conversation
ID; non-operator lanes retain their channel target. A private mode-0600 SQLite
registry owns each lane's session and continuation token. The redacted lane
snapshots and provider-pressure traces cannot contain those tokens, and a token
or session observed in a second lane fails closed.

All lanes load the same authored agent definition and soul, resolve the same
configured provider identity, and receive a short dynamic instruction stating
their local authority. HTTP remains the authenticated TUI lane. Future Discord
voice and gameplay adapters must provide `captainLane` and `captainTargetId` in
their existing Eve channel metadata; this package does not implement either
channel.

The provider admission controller serializes bursts within one conversation.
Different conversations run concurrently when provider capacity permits it.
Operator conversations outrank voice/presence and gameplay without a
device-specific reservation. Streamed model calls retain their permit until the
stream actually settles. See `docs/16-operator-conversations.md` for the public
contract and v1 migration behavior.

## Skill verification

`pnpm --filter @clankie/captain-eve test` compiles the authored Eve surface without provider credentials and verifies that all mission skills are discovered. `pnpm --filter @clankie/captain-eve exec eve eval --list` validates the behavior-eval definitions.

With captain model credentials configured, run `pnpm --filter @clankie/captain-eve exec eve eval skills --strict` to verify that mission-shaped prompts load the matching skill and an unrelated prompt does not load one.

## Tracker ceremony projection

The captain loads the effective compiled tracker ceremony from an
HMAC-authenticated channel-metadata envelope signed by the control plane with
`CLANKIE_CAPTAIN_TOKEN`. Unsigned or modified caller context is ignored by the
dynamic `agent/instructions/ceremony.ts` module. A short root rule in `instructions.md`
requires following that projection and governed tools for draft validation and
human-attention delivery. Portable captain surfaces never hard-code personal
emails, tracker labels, or mention syntax. Notification delivery is not a reply;
only verified agent-session correlation may close pending attention.
