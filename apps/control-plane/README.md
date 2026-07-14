# Control plane

This service owns mission state, doctrine compilation, action decisions, approvals, and the semantic event stream. Mission and approval projections rebuild from the durable append-only event store on startup.

It must never own provider subscription credentials or terminal processes. Those remain on the local runner.

## Time-triggered missions

Mission triggers are durable event-replayed records with either a one-shot ISO timestamp or a UTC five-field cron schedule. The cron subset accepts `*`, one numeric value, comma-separated numeric values, and `*/step`; ranges, names, aliases, and other syntax fail validation. A 30-second control-plane evaluator and the authenticated manual evaluation seam use the same pure `nextFireAfter` calculation.

Trigger create, update, and delete operations require an authenticated operator and are classified as the reversible action `mission.trigger.write`. Missing classification, denial, and approval-required results all fail closed without mutation. Firing uses the ordinary mission-draft path and records the compiled doctrine cost, wall-time, and parallel-worker bounds in scheduled context; planning and execution still enforce the same immutable doctrine profile as operator-created missions.

`skip` drops a missed occurrence, while `run_once_late` creates one catch-up mission regardless of how many cron occurrences elapsed. Evaluation is serialized and the mission identity is deterministic per trigger occurrence, preventing concurrent evaluation or restart retries from producing a catch-up storm. Created, updated, deleted, fired, and skipped transitions are semantic events in the durable event store.

## Governed mission memory

The control plane is the trusted caller of `@clankie/memory-store`. An authenticated worker or captain may submit a strict bounded fact proposal, but submission only emits `memory.proposal.submitted` and evaluates the existing `memory.profile.write` action. A denial emits `memory.proposal.denied`; `require_approval` creates an ordinary durable approval request. The store is never called directly from model input.

An authenticated operator decision remains authoritative in the approval projection. Approval emits `memory.proposal.approved`, and only then does the control plane rebuild the store's approved envelope from the recorded proposal and approval before calling `applyApprovedProposal`. Commit emits `memory.proposal.committed`. Replay reconciles an approved proposal without a commit event, while the store's proposal receipt and the control-plane commit projection make retries idempotent. Operator denial emits the same denied semantic event without mutating memory.

At plan time, bounded keyword recall is combined with the doctrine planner card in `captainMissionContext`. Runner assignments receive a smaller task-query recall excerpt in task metadata. Both projections are untrusted context, not authority or instructions. Retention pruning runs when the loaded doctrine retention differs from the last recorded run and on a daily maintenance cadence; every run emits `memory.retention.pruned` with bounded fact ids and no fact bodies.

## Runner pull execution

After a validated implementation-plus-read-only-verification plan is submitted, an authenticated captain starts it with `POST /v1/missions/:id/start`. An authenticated runner pulls work from `POST /v1/runner/claims`, heartbeats the server-owned attempt lease, reports allowlisted idempotent semantic events, and settles the exact attempt. `GET /v1/missions/:id` includes the live task snapshot and results.

The execution boundary is fail-closed: `CLANKIE_CAPTAIN_TOKEN` authenticates start separately from `CLANKIE_RUNNER_TOKEN`; missing configuration returns an unavailable error and invalid credentials return an authentication error. Production authenticators compare bearer credentials in constant time and bind the runner ID from server configuration, never a caller header. The control plane owns serialized scheduling and replay only. Codex, Git worktrees, provider processes, and credentials remain in the runner.

## Worker steering command bus

Authenticated captain steering is normalized into a versioned command bound to
the active mission, task, worker run, attempt, owning runner, lease, correlation
identity, and doctrine profile. The private payload queue is atomically persisted
beside the event store with mode `0600`; mission events contain only content
length and SHA-256, never steering text. Runner claim and settlement endpoints
revalidate attempt, runner, and lease authority and return typed non-delivery
outcomes for stale, terminal, unsupported, or human-controlled workers.
Claiming is a one-way delivery transition: restart reconciliation marks a
claimed-but-unsettled command as failed instead of replaying it to the adapter.

The request accepts a finite typed intent surface: focus on the current task,
failing test, acceptance criteria, scope, or diagnosis; continue; retry the last
step; or summarize status. The control plane renders the provider text from
that intent. Legacy strings fail closed unless they exactly match a canonical
safe intent, so approval answers, credentials, merge/deploy permission, policy
overrides, and control characters never enter the payload store. Duplicate
command IDs are idempotent only when their worker run and rendered content hash
match.

Steering authorization is required and fail-closed. The authenticated principal
supplies the trusted source lane; request bodies may only assert the same lane
and cannot elevate a captain to the TUI. Production binds the captain lane with
`CLANKIE_CAPTAIN_STEER_SOURCE_LANE=api|discord_text|discord_voice`; operator
steering is bound to `tui`. Runner settlement diagnostics are hash/length-only
audit metadata, while the durable outcome message is derived from its typed code.

## Verification recovery

An authenticated captain can add one bounded recovery pair after a read-only
verification task settles failed. `POST /v1/missions/:id/recovery` accepts a
debugger task and a read-only re-verifier task; it does not accept diagnosis or
verification authority from the caller. The control plane copies the failed
task's stored diagnosis, evidence, and trusted
`runner-check:<id>:sha256:<digest>` identities into reserved recovery metadata.

The debugger inherits the original implementation lineage and exact write
scope, and is routed away from the original implementer and verifier. The
re-verifier depends only on the debugger, remains read-only, and is routed away
from both writing attempts; the original read-only verifier remains eligible in
the production three-seat fleet.
Recovery command IDs are idempotent and fail closed when reused with different
content.

```mermaid
flowchart LR
  I[Original implementation] --> V[Failed read-only verification]
  I --> D[Bounded debugger]
  V -. diagnosis + evidence .-> D
  D --> R[Independent unchanged re-verification]
  V -. historical failure retained .-> X[Explicit failure resolution]
  R --> X
  X --> S[Mission succeeds]
```

One atomic `recovery.pair.added` event contains both full `TaskSpec` values and
the recovery record, so SQLite replay never exposes one task without the other.
Legacy partial recovery `task.added` events are not schedulable. A successful
re-verifier resolves rather than rewrites the original failure. Mission success
requires the original check ID plus canonical command, arguments, dependency,
and sandbox digest identities, and terminal success is emitted once. A complete
`worker.settled` result is durable before its terminal task projection, so crash
prefix replay retains the evidence needed for recovery. Caller-supplied reserved
recovery metadata is rejected.

## Captain presence

Eve registers and renews its process generation through the captain-authenticated
`POST /v1/captain/presence` route. The control plane owns the lease and its timer,
so it appends `captain.presence.offline` even when the Eve process disappears.
Renewals are idempotent and every heartbeat extends the lease, while durable
`captain.heartbeat` events are sampled to keep the semantic stream sparse.

The same route accepts typed Eve lifecycle reports for turn start, turn settlement,
waiting on a dependency, and the bounded waiting-for-user state. The control plane
appends those reports, online/offline transitions, and sampled heartbeats to the
authoritative event store under the current doctrine hash. Callers cannot submit an
offline transition or a generic Tier-0 status signal.

```mermaid
sequenceDiagram
    participant E as Eve captain
    participant C as Control plane
    participant S as Event store

    E->>C: Authenticated lifecycle report + lease identity
    C->>S: captain.presence.online + typed lifecycle event
    loop Every heartbeat interval
        E->>C: Authenticated heartbeat
        C->>C: Renew lease idempotently
        C-->>S: Sampled captain.heartbeat
    end
    Note over E,C: Eve process disappears
    C->>C: External lease timer expires
    C->>S: captain.presence.offline
```

## Capability exchange

The worker capability routes compose three injected boundaries:

```mermaid
sequenceDiagram
    participant W as Worker
    participant C as Control plane
    participant D as Doctrine
    participant B as Runner-owned audited broker
    participant G as Runner-owned GitHub connector

    W->>C: Request action + exact resource
    C->>C: Authenticate runner session
    C->>C: Resolve trusted checks, approvals, and mission risk
    C->>C: Classify action from registered connector metadata
    C->>D: Decide under immutable profile hash
    alt decision is allow
        C->>B: Issue mission/worker/action/resource grant
        B-->>W: Short-lived signed token
        W->>C: Execute GitHub action with token
        C->>B: Consume exact scoped grant
        B-->>C: Audited allowed/denied decision
        C->>G: Execute typed operation + signed obligations (no credential field)
    else deny or require approval
        C-->>W: Refuse without minting
    end
```

`POST /v1/workers/:id/capabilities` mints only when doctrine returns
`allow`; `deny` and `require_approval` are both refusals. The grant is bound
to the authenticated mission, task, worker run, action, resource, doctrine
hash, signed policy obligations, and an expiry of at most 15 minutes. Check,
approval, change, cost, and mission-risk facts come from an injected
authoritative context provider. The connector risk class comes from an
injected metadata classifier that produces opaque, in-process
classifications. Worker-supplied policy facts and class fields are discarded,
and unclassified connector actions fail closed.

## Authenticated approvals

A `require_approval` policy result appends `approval.requested` with the exact
mission, worker, action, resource, policy rationale, correlation identity, and
doctrine hash. `GET /v1/approvals?status=pending` and
`POST /v1/approvals/:id/decision` require the dedicated operator authenticator
configured by `CLANKIE_OPERATOR_TOKEN`; captain and worker credentials cannot
grant approval authority.

Approve and deny append `approval.decided` with the authenticated operator ID,
time, and reason. A decision never invokes a connector. The original action
request must return through doctrine; an approval is bound to that exact
request and is consumed once when a capability grant is issued. Replays of the
same decision are idempotent, while conflicting decisions fail closed.

`POST /v1/workers/:id/connectors/github/execute` consumes that exact grant
before invoking the connector. The control plane receives an abstract broker
and connector from the local runner. Neither interface exposes a provider
credential or worker environment, so secrets remain inside the privileged
connector boundary. The runner generates the operation/idempotency ID and the
connector returns no payload. Any unexpected connector result fails closed;
the worker receives only the runner-generated ID and a constant acceptance
flag.

## Device pairing and per-device permissions

Pairing turns a `clankie pair` offer into a durable, per-device identity with
host-authoritative grants. The flow (ADR 0035):

```
operator: POST /v1/pairing/offer        → QR deep link + typed code (5-min, single-use)
device:   POST /v1/pairing/redeem        → pending device + offered grants + completion token
device:   POST /v1/pairing/complete      → active device + session token
device:   GET  /v1/devices/self          → restore session on launch
device:   POST /v1/devices/self/session/refresh → new token (grants from projection)
operator: GET  /v1/devices               → list devices
operator: POST /v1/devices/:id/revoke    → revoke a device
```

| Route                                   | Auth                 | Success         | Fail-closed                                                                   |
| --------------------------------------- | -------------------- | --------------- | ----------------------------------------------------------------------------- |
| `POST /v1/pairing/offer`                | operator             | offer wire      | 503 / 401                                                                     |
| `POST /v1/pairing/redeem`               | offer secret or code | redeem response | 400 malformed · 409 consumed · 410 expired                                    |
| `POST /v1/pairing/complete`             | completion token     | session token   | 410 expired · 409 replay · 403 revoked · 403 `terminal_control_not_grantable` |
| `POST /v1/devices/self/session/refresh` | device               | new token       | 503 / 401                                                                     |
| `GET /v1/devices/self`                  | device               | self view       | 503 / 401                                                                     |
| `GET /v1/devices`                       | operator             | device list     | 503 / 401                                                                     |
| `POST /v1/devices/:id/revoke`           | operator             | device row      | 503 / 401 / 404                                                               |

Offers and completion tokens live in memory (5-minute and 10-minute TTLs); a
restart drops in-flight pairings — fail closed. Device records are durable and
event-sourced on the `device:${deviceId}` stream; the same transition function
runs live and on replay, throwing on any impossible transition.

Session tokens are HMAC-signed and carry **identity only** — `{version, deviceId,
issuedAt, expiresAt, nonce}`, no grants. Grants and liveness come from the
projection on every request, so refresh can never widen access and per-device
revocation kills every token the device holds. The signing key is a mode-0600
file auto-minted next to the event store (`CLANKIE_DEVICE_SESSION_KEY_PATH`
overrides it); an unreadable key fails device routes closed with 503, and
deleting the key revokes every device. `terminalControl` is never granted this
slice (the runner gateway is observe-only); accepting it is denied without
consuming the completion token so the device retries with Supervise. No event or
log line carries a token, token hash, or offer secret — only `deviceId` and
`offerId`.

## Tracker authority mirror

The trusted `TrackerMirrorPort` imports intent, priority, and acceptance
criteria through `POST /v1/tracker/missions`. Plan submission validates that
contract; reconciliation records `tracker.drift.detected` without rewriting it.

Durably appended mission events become idempotent comments with worker
attribution. `worker.leased` mirrors the Clankie app as delegate; tracker state
never decides worker ownership.

Priority and completion use distinct policy-gated actions. Failures emit
credential-free `tracker.sync.failed` events.

## Narrative and captain channel seam

`POST /v1/discord/presence-actions` accepts bot-transport Discord presence writes (ADR 0024), gates them on the bridge-owned gateway/voice session projection, evaluates narrative or risk-class policy (shared narrative rate ledger), and executes via `discordPresenceRuntime` loaded from `CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE`.

`POST /v1/tracker/narratives` accepts only the five typed narrative actions (issue comment, thought, response, elicitation, and reaction) and evaluates exact content plus trusted correlation through one `createNarrativeWritePolicy()` instance retained for the compiled profile runtime. It then delegates to `LinearAgentRuntimePort`; non-narrative tracker mutations cannot enter this route.

`POST /v1/captain/channel-turns` accepts Linear agent-session turns and authenticated Discord text turns. It namespaces delivery idempotency by provider and calls Eve over its canonical loopback session/NDJSON surface. Linear turns read their authoritative activity thread through the trusted runtime and retain their verified agent-session cursor. Discord turns require a captain credential whose server-authenticated source lane is `discord_text`; their trigger and capped context arrive only as untrusted, turn-only Eve `clientContext` (ephemeral and excluded from durable session history) with explicit `discord_presence` lane metadata. The durable Eve message is content-free, and the adapter retains no continuation cursor after the bounded result. The route returns only `settled`, `waiting_user`, or a bounded failure.

At startup, `CLANKIE_LINEAR_AGENT_RUNTIME_MODULE` may name an absolute trusted local module exporting `createLinearAgentRuntime()`. The module owns broker-backed construction; the control plane receives only the credential-free port. When it is absent, both Linear runtime routes fail unavailable. `CLANKIE_CAPTAIN_URL` defaults to the loopback Eve service.

When Linear human attention is enabled, `CLANKIE_LINEAR_ATTENTION_RUNTIME_MODULE` is required and exports `createLinearAttentionRuntime()`. Its credential-owning client and workspace config map semantic `operator` capabilities to the provider assignee, `needs-human` label, and direct mention. Startup fails closed when the Linear agent runtime is enabled without this companion runtime.

The control-plane HTTP service binds to `127.0.0.1`. The narrative and captain-channel routes rely on that local process boundary and are not public connector APIs.

### Discord presence actions

`POST /v1/discord/presence-session-events` accepts authenticated semantic phase transitions from the Discord bridge. The retained projection validates a clean process start, contiguous revisions, and the prior phase. A new bridge process may replace the prior generation for the same transport/character/credential binding only with its revision-one `off` → `connecting` transition. `GET /v1/discord/presence-sessions` returns the authenticated projection for status surfaces.

`POST /v1/discord/presence-actions` — ADR 0024 bot-transport presence catalog. The current projected session controls catalog availability before policy evaluation or runtime execution, so disconnect, lease loss, and failure remove act capability immediately. Narrative actions use the shared rate ledger under either real mission attribution or a stable ambient presence-session attribution; non-narrative actions require a mission. Optional `content` is derived from the payload when omitted (emoji, typing sentinel, …). Attachments mint a bounded approval request carrying only the artifact reference and write hash. An authenticated operator decision resumes the exact idempotency key; denial and expiry remain terminal. The broker-backed runtime resolves `sha256:<digest>:<relative-path>` beneath `CLANKIE_DISCORD_ATTACHMENT_ROOT`, verifies the bytes inside the privileged Discord boundary, and never places bytes in control-plane events or logs. Runtime: `CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE` exporting `createDiscordPresenceRuntime()`.

## Tracker ceremony routes

- `POST /v1/tracker/issue-drafts/validate` — pure draft validation against the compiled ceremony projection.
- `POST /v1/tracker/human-attention/deliver` — policy-evaluated, idempotent attention delivery with typed aggregate outcomes.
- `POST /v1/tracker/human-attention/correlate` — correlate verified agent-session events to pending attention (ordinary issue comments never match).

Eve channel turns carry the ceremony projection only in an HMAC-authenticated channel-metadata envelope signed with `CLANKIE_CAPTAIN_TOKEN`. Unsigned or modified caller context is ignored.
