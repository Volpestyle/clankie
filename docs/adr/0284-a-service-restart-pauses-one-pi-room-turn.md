# ADR 0284: A service restart pauses one Pi room turn

Status: accepted for the bounded prototype in [VUH-2574](https://linear.app/vuhlp/issue/VUH-2574), 2026-10-20.
Widened on 2026-11-02 to every owner-only audience; see the amendments below.

## Context

Clankie's Pi coding-agent 1.0.0 sessions retain conversation history, but an
unfinished turn and its delivery receipt become interrupted when the service
exits. A resumed conversation is not a resumed execution: a tool may have
committed its effect without recording its result. Deploying the service must
not require guessing whether to repeat that call.

The [comparison](../proposals/2026-10-20-durable-pi-turns.md) reviews Pi Durable,
Vercel's durable-harness and a local journal, including their storage and session
formats. The lead approved a minimal journal before implementation. Native seats
keep their own transcripts and are outside this decision.

## Decision

Prototype a local step journal around the existing coding-agent AgentSession.
Do not replace its session format, resource loader, extensions or tool registry.
The service host could select exactly one text-room target with
`CLANKIE_DURABLE_PI_ROOM=guildId:channelId` (`dm:channelId` for a private DM).
Absent, the prototype was disabled. This development rollout switch was not an
owner preference or a new authority grant; the owner-only amendment removed it. A linked main conversation or a room
routed to a native seat is refused by the prototype.

The public channel-turn route retains the full admitted request only for that
selected target. After its original process is proven dead, startup resubmits
that exact request internally without requiring another HTTP input. It retains
the original delivery ID, fingerprint and final result. Current settings and the
original authority fingerprint must agree before any resumed work. A request
is evidence of prior admission, never saved authority. The normal service's
exclusive body-store process lock remains the single-writer boundary; this
prototype does not support multiple writers or failover between hosts.

Each delivery has a private journal beneath `captain/durable-pi-room/`, beside
its native Pi session. Admission records the session path and leaf. Recovery
opens the same native tree and branches at that saved leaf; the interrupted
branch remains evidence. Deliveries on the selected room are serialized, rather
than steered into an unjournaled concurrent turn (since amended: a steer is now
journaled; see below). The prompt is pinned; completed
model responses and tool results are returned from the journal. An interrupted
model request uses its saved context and fresh provider credentials. Credentials
are never saved in the journal.

Intent and outcome writes use an exclusive temporary file, fsync, rename, then
fsync of the directory. No tool starts before its intent is durable, and Pi sees
no terminal model response before it is durable. A write failure poisons the
journal and prevents later effects. Invalid journals, missing native session
history after any step, changed grants and changed tool declarations and mismatched tool names/arguments fail
closed. A normal service shutdown leaves the admitted delivery pending rather
than recording its cancellation as a terminal answer.

Completed tools are never executed during replay. Only exact observations are
`safe`: `read`, `memory` with `action: search`, `get_self_state`,
`agent_sessions`, `agent_session_read`, and `mcp_tool_search`. Unknown tools,
Discord sends, seat messages/hires, Linear writes, generic connected-service
calls, memory writes/edits/deletions, shell/file mutations, browser/gameplay
operations and mixed adapters are `never`. A `never` intent with no outcome
becomes an error result stating that it **possibly ran**. The model may inspect
its destination or original receipt; the runtime does not retry that call.
The [comparison's tool table](../proposals/2026-10-20-durable-pi-turns.md#tool-replay-policy)
carries the full classification rationale. Tool-result media capture is restored
with the saved outcome so replay does not discard an already produced attachment.

```mermaid
sequenceDiagram
  participant HTTP as Channel-turn HTTP
  participant Journal as Private journal
  participant Pi as Existing Pi session
  participant Tool as Tool dependency
  HTTP->>Journal: Admit original delivery and request
  Pi->>Journal: Commit model request and final response
  Pi->>Journal: Commit tool intent
  Pi->>Tool: Execute once
  Note over Pi,Tool: Service can die after the effect
  HTTP->>Journal: Startup recovery, same delivery ID
  Journal->>Pi: Branch at admission; replay completed steps
  alt interrupted safe read
    Pi->>Tool: Observe again
  else interrupted never call
    Journal->>Pi: Possibly ran; inspect receipt/destination
  end
  Pi->>Journal: Commit final result
  HTTP->>HTTP: Existing reply delivery and reconciliation
```

## Explicit receiver-idempotency boundary

A local journal cannot atomically commit a remote Discord or Linear effect with
its local outcome. `never` prevents automatic replay; it does not prove an effect
was absent, and does not prevent a model from proposing a new call. Exactly-once
remote delivery requires a receiver idempotency key or authoritative read-back
reconciliation. The final reply continues to use the existing Discord turn/write
receipts and mouth reconciliation; this prototype adds no alternative publisher.

The lead explicitly declined a Discord destination for the proof. Verification
therefore ends at the real public HTTP result and existing final-reply receipt
boundary. Actual Discord-mouth delivery is **unproven** and remains a rollout
requirement on VUH-2574. One saved HTTP reply result is not evidence that Discord
received exactly one post.

## Verification and rollout

The manual real-dependency proof is
[`prove-durable-pi-room.ts`](../../apps/clankie/scripts/prove-durable-pi-room.ts).
It starts the real service with a generated scratch-stack preset, private ports,
state, settings, credentials and no Discord connection. It uses a real API model,
real file memory and a real shell effect. It kills only its own service and
verified tool PID while the effect is in flight, then starts the service again.
Since the 2026-11-02 amendment below, it also registers a bot body and redelivers
the same request, as the bridge would. It checks one persisted memory, one shell append, the
possibly-run result, one terminal reply receipt, exact replay across repeated
HTTP input and another restart, and a changed-input conflict. This is a manual
product proof, not an eval or a per-commit network test. Its evidence is linked
from VUH-2574 and the [testing record](https://github.com/Volpestyle/clankie-ops/blob/main/archive/clankie-docs-testing/2026-10-20-vuh-2574-durable-pi/README.md).
Both SIGKILL and SIGTERM proofs passed against unchanged source, with one memory,
one shell append and one saved HTTP reply each.

The automated regression base is
[`durable-pi-room-restart.integration.test.ts`](../../apps/clankie/test/durable-pi-room-restart.integration.test.ts)
(2026-11-02, [#368](https://github.com/Volpestyle/clankie/issues/368)). It runs the
same real service, Pi, journal, file memory and shell, killed mid-shell and started
again. A bot body registers over HTTP and redelivers the same request. Only the model is a scripted loopback endpoint,
so it costs nothing and proves the restart contract rather than model behaviour. It
checks:

- the shell call surfaces as "possibly ran", with one effect and one memory;
- after the restart the model is asked only for the answer, since completed steps come from the journal;
- the same delivery replays its saved result, a changed request is refused, and a later clean restart replays it with no model call;
- a grant changed while the service was down fails the resumed turn closed, with no model or tool step;
- the restart keeps the room handoff open, and nothing resumes until the body redelivers;
- a graceful stop (SIGTERM) pauses the handoff rather than failing it, and its journaled shell outcome is never rerun.

[`durable-pi-room-steer.integration.test.ts`](../../apps/clankie/test/durable-pi-room-steer.integration.test.ts)
kills the turn with a follow-up steered into it. One case kills it before Pi read the
follow-up and the other after. In both, the resumed turn's one new model request
carries the follow-up exactly once, after the same tool results, and the redelivered
follow-up settles `absorbed` with no model call of its own.

[`durable-pi-room-delivery.integration.test.ts`](../../apps/discord-bridge/test/durable-pi-room-delivery.integration.test.ts)
carries the same kill through the bridge. The bridge's real SQLite inbox, text
ingress and presence session submit an owner DM. The service is killed mid-shell and
started again, and the bridge reopens its inbox. The reply then leaves through the
bridge's bot presence runtime and discord.js REST, exactly once and threaded to the
original message. A later bridge pass over that message posts nothing and asks the
model nothing. The test loads the runtime from a fixture module that skips the
credential broker, and its Discord is a loopback REST fixture. It therefore proves the
service-to-bridge-to-REST hop, not Discord's API or gateway.

A second case in the same file covers a crash between Discord's send and its receipt
(2026-11-03). The loopback Discord accepts the reply into the channel and never
answers. The service is SIGKILLed at that moment, and both sides restart. On the
bridge's redelivery, the mouth's reply reconciliation reads the channel back, finds
the reply threaded to the owner's message, and settles the delivery. Discord has one
post, the model is not asked again, and a further restart and redelivery post
nothing. With reconciliation disabled, the case fails. The scratch service it runs is
isolated by construction, and the fixture asserts this before it starts:

- an environment built rather than inherited;
- every path under its own temporary root;
- file credentials, never the Keychain broker;
- fresh loopback ports, never the live 4310 or 4321;
- loopback addresses only;
- Herdr off.

## Amendment: the room takes the normal handoff (2026-11-02, [#368](https://github.com/Volpestyle/clankie/issues/368))

The opt-in room no longer runs on a separate prototype path. Its deliveries take
the same room handoff as every other room: a handoff record the room's views read,
the room's guards, and native routing. An owner audience with a live Claude or Codex
head therefore answers in a native child, and the journal does not apply there. The
journal now wraps only the handoff's Pi dispatch, the fallback when no native head
takes the turn. The earlier refusal of seat-routed and linked-main requests becomes
their normal routes. Two differences from other rooms remain, each stated where
it lives in `captain.ts`:

- It uses no room loop (ADR 0291), because a loop keeps one warm session across
  turns and the journal holds one turn.
- A restart leaves its handoff `running` while that delivery's journal is unsettled,
  instead of marking it interrupted. A shutdown pauses it the same way. Only the
  same delivery may reopen that handoff.

Recovery no longer starts at boot. The room's guards need its Discord body live and
able to reply, and at boot no body has connected. The turn resumes when its body
redelivers the same request from the bridge's durable inbox, which the bridge does
on its own. The resume still re-evaluates current grants, and a changed grant fails
it closed against the journal.

### Steering is journaled (2026-11-02)

The room steers like every other room (ADR 0118): the same sender's follow-up under
the same grant joins the running turn. Before Pi sees it, the follow-up is recorded
twice, durably. Its own directory gets a link to the turn it joined, and the turn's
journal gets the steer, with the last journaled step it arrived after. A resumed turn
queues each steer again once that step is served. Pi delivers steering after the
current assistant turn's tool calls and before the next model request, so the
resumed turn hears the follow-up at the same point, once.

A follow-up's own answer is its parent's. When the bridge redelivers it after a
restart, it reads the parent's journal. If a journaled model request carried the
follow-up, it settles `absorbed` with the parent's reply, or failed if the parent
failed. If the parent ended without reading it, the follow-up becomes its own
handoff, exactly as in a running room. A parent that has not resumed yet is resumed
from its own saved request, with every guard and its journal's grant checked again.
The store keeps a joined follow-up's handoff open across the restart, as it does for
its parent.

### Owner-only audiences (2026-11-02)

The single-room dev switch is gone. A Pi room turn is durable when its room grant,
resolved as the turn runs, proves an owner-only audience. Four conditions must hold:

- the owner is speaking;
- through the official bot;
- in a DM or a room whose owner-only audience the room's existing proof establishes
  (`access.privateContext`);
- with no room skill grant and no participant character.

**This changes only what survives a restart, never what anyone in the room can do.**
Routing, tools, guards and replies are the room's own; the journal records the Pi
dispatch they already run. To resume a turn, the service needs the full request, so
it retains that only for the owner's own text through the official bot. It resumes
only a delivery that has a journal or joined a journaled turn. A settled journal
still answers when the service died after the journal settled but before the
receipt did; the redelivery gets the saved answer, not "unanswered", with no model
call ([#497](https://github.com/Volpestyle/clankie/issues/497), covered by
`durable-pi-room-restart.integration.test.ts`). A journaled
turn whose audience no longer qualifies when it resumes fails closed, as a changed
grant does.

Mixed rooms (any reader beyond the owner), the user-session body, voice, native
children and linked-main execution keep their existing interruption behaviour, for
these reasons:

- **Mixed rooms.** A resumed turn would act for an audience that the restart may
  have changed, and its journal holds replies meant for that audience. Widening
  there needs its own decision about what a reader joining mid-turn may see.
- **Voice.** It has its own floor and latency budget, and a minutes-late spoken
  answer after a restart is worse than none.
- **Native children and linked main.** Their harness keeps its own transcript, and
  ADR 0284 excludes them.

[`durable-pi-owner-audience.integration.test.ts`](../../apps/clankie/test/durable-pi-owner-audience.integration.test.ts)
covers which turns are journaled. It uses the real captain, Pi and journal, a
scripted model, and Discord channel and guild reads served as fixture data, so the
real owner-only audience proof runs. The owner's turn in a proven owner-only room
is journaled; the same owner's turn in a room others can read is not. The restart
suites above now run on owner DMs with no switch set.

### Retention and compaction (2026-11-02)

A journal is replay machinery, not the turn's record. When a turn settles, its
journal keeps only:

- the request, the grant and the answer;
- whether each follow-up was heard (precomputed, so the absorbed answer survives);
- the tool calls that are never replayed, with their outcomes. These are the effects
  the turn could not be sure of, including any "possibly ran".

It drops every model context, the exact observations that were safe to replay, the
system prompt and the tool-registry digest. Each model step held the whole context
again, so these made a journal grow with the square of its length. The turn's Pi
session file stays beside it as its trail, as every other room turn's does. At
settlement the delivery receipt also drops the request it kept for recovery: a
settled delivery answers redelivery from its saved result.

Each service start sweeps the journal root. It compacts settled journals written
before compaction existed. It removes a settled delivery's whole directory (journal,
follow-up link and Pi session) after `OPERATOR_CONVERSATION_RETENTION_MS` (30 days),
the same window as the room handoffs that ran those turns. The window counts from
the last write. It keeps:

- an unsettled journal or follow-up link, however old: it is uncertain work that
  waits for its delivery to return;
- a settled turn that an unsettled follow-up still names as its parent;
- unreadable state, for the recovery that refuses it.

[`durable-pi-retention.integration.test.ts`](../../apps/clankie/test/durable-pi-retention.integration.test.ts)
covers both paths with the real service restarted. The first test checks the
compacted shape and that the receipt drops its request. It then ages the journal
just inside and then past the window: the directory is removed only past it, and
the redelivery still answers from the receipt without a model call. The second test
shows that an unsettled journal twice the window's age survives and resumes.

### Provider outages (2026-11-02)

Pi retries a retryable provider error (overload, rate limit, 5xx, network) three
times in-process, over about fourteen seconds. When a durable turn's last step is
still such an error after those retries, the turn is not failed. Instead:

- the journal drops the trailing failed attempts, so the turn ends at its last good
  step;
- the journal records when the outage began and counts the attempts;
- the turn stays unsettled, and its handoff keeps running.

The route answers the body's poll with 502 uncertain, and the bridge's inbox retries
the message with its own backoff (30 seconds, doubling to 10 minutes). Each
redelivery resumes the turn in this process or after a restart: completed steps
replay, and only the failed model request is asked again. A follow-up joined to the
turn stays joined, as it does across a shutdown.

The wait is bounded by `PROVIDER_OUTAGE_WAIT_MS` (one hour from the first deferral).
Past it, the turn settles failed once, and later redeliveries answer from the
receipt. No timer in the service retries anything: the body's redelivery is the only
trigger, so nothing loops while the body is away. Errors Pi does not retry, such as
quota, billing and context overflow, fail the turn as before.

[`durable-pi-provider-outage.integration.test.ts`](../../apps/clankie/test/durable-pi-provider-outage.integration.test.ts)
runs the real service against a model that answers 503. It covers three cases:

- a deferral, a redelivery while still down, then the answer once the provider is
  back, with the memory write never repeated;
- a deferral that survives a SIGKILL restart;
- an outage aged past the wait, which fails once and then answers from the receipt
  without asking the model.

A follow-up joined during an outage is not covered by a test.

### Media generation (2026-11-03, [#368](https://github.com/Volpestyle/clankie/issues/368))

`generate_image` and `generate_video` are `never` replays. A picture finished before
the restart is in the journal with its media capture. The resumed turn takes it from
there and attaches it to the reply, and the provider is not asked again. A render
the restart interrupts surfaces as "possibly ran" and is never requested again.
[`durable-pi-media.integration.test.ts`](../../apps/clankie/test/durable-pi-media.integration.test.ts)
proves both with the real service killed and started again. Its image provider is a
loopback stand-in reached through `CLANKIE_TEST_MEDIA_API`, a test seam in
`media-extension.ts`. The seam is honoured only when both `CLANKIE_SCRATCH=1` and
`NODE_ENV=test`. The product code refuses any address that is not plain http on
`127.0.0.1` or `[::1]`, and strips every credential header and `key` query
parameter, so the seam never carries a credential. Any other run ignores it. A video render that comes back `pending` keeps
rendering outside the turn, and that path is not covered.

### A revoked model credential (2026-11-03, [#368](https://github.com/Volpestyle/clankie/issues/368))

A provider that refuses the credential (401) is not an outage: Pi does not retry it
and the journal does not defer the turn. A turn whose model credential is revoked
while the service is down resumes from the journal on its redelivery. Its completed
steps are served from the journal and its interrupted shell call surfaces as
"possibly ran". Its one new model request is refused, so the turn settles failed,
once. Restoring the credential does not reopen it. Later redeliveries, including
after another restart, answer from the saved failure without asking the model, and
no tool runs again. The owner sends a new message to continue.
[`durable-pi-credential-revoked.integration.test.ts`](../../apps/clankie/test/durable-pi-credential-revoked.integration.test.ts)
covers this with the real service killed mid-shell and a scripted model that answers
401 after the restart.

Before enabling more lanes:

1. Prove the full mouth hop, including a crash between send and receipt, through
   existing reconciliation. Done against a loopback Discord (above). Discord's real
   API and gateway still need an approved private test destination.
2. Exercise interrupted model/read, several tools in one round,
   media capture and changed/revoked room grants with real dependencies (changed
   grants, a revoked model credential and image capture are done, above). Preserve
   corrupted/missing-state refusals. Audit connected reads individually rather
   than broadly blessing a transport.
3. Done: retention and compaction, and provider outages (above). Keep the original request and uncertain intents until
   reconciled. Recovery happens on the body's redelivery; a failed recovery
   settles once and does not create an unbounded automatic retry loop.
4. Extend the same admission/step/outcome contract to linked-main service execution, mixed rooms, voice handoffs, operator turns, hosted encrypted ingress,
   watches, scheduled wakes and background service lanes. Persist queued inputs,
   preserve source/audience ceilings, and define explicit cancellation separately
   from a service pause. Native seats remain excluded.
5. Revisit Pi Durable before expanding the journal into general task scheduling,
   forks, distributed fencing or a second conversation database. Prefer adopting
   its native durable tasks if that migration becomes smaller than maintaining
   equivalent machinery. Self-hosted storage remains mandatory; no Vercel service,
   Sandbox, gateway or managed World is required by this decision.

The live service is never restarted by this prototype proof or its rollout checks.

## Revisit when

The provider retry classification/backoff, journal retention or room audience changes, or an outage no longer recovers under the documented bounds. Rerun the existing restart, delivery, outage and revocation integration proofs, with a separate live proof for audience delivery. The existing verification plan still governs any expansion to general scheduling or new execution lanes.
