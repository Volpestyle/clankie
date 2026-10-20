# ADR 0284: A service restart pauses one Pi room turn

Status: accepted for the bounded prototype in [VUH-2574](https://linear.app/vuhlp/issue/VUH-2574), 2026-10-20.

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
The service host can select exactly one text-room target with
`CLANKIE_DURABLE_PI_ROOM=guildId:channelId` (`dm:channelId` for a private DM).
Absent, the prototype is disabled. This development rollout switch is not an
owner preference or a new authority grant. A linked main conversation or a room
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
than steered into an unjournaled concurrent turn. The prompt is pinned; completed
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
verified tool PID while the effect is in flight, then starts the service again
without another input. It checks one persisted memory, one shell append, the
possibly-run result, one terminal reply receipt, exact replay across repeated
HTTP input and another restart, and a changed-input conflict. This is a manual
product proof, not an eval or a per-commit network test. Its evidence is linked
from VUH-2574 and the [testing record](../testing/2026-10-20-vuh-2574-durable-pi/README.md).
Both SIGKILL and SIGTERM proofs passed against unchanged source, with one memory,
one shell append and one saved HTTP reply each.

Before enabling more lanes:

1. Obtain an approved private Discord test destination and prove the full mouth
   hop, including a crash between send and receipt, through existing reconciliation.
2. Exercise interrupted model/read, several tools in one round,
   media capture and changed/revoked room grants with real dependencies. Preserve
   corrupted/missing-state refusals. Audit connected reads individually rather
   than broadly blessing a transport.
3. Add retention/compaction for step journals and durable retry/backoff for
   unavailable providers. Keep the original request and uncertain intents until
   reconciled. Current recovery is on service startup; a failed recovery does
   not create an unbounded automatic retry loop.
4. Extend the same admission/step/outcome contract to Pi room handoff children,
   linked-main service execution, owner DMs, voice handoffs, operator turns, hosted encrypted ingress,
   watches, scheduled wakes and background service lanes. Persist queued inputs,
   preserve source/audience ceilings, and define explicit cancellation separately
   from a service pause. Native seats remain excluded.
5. Revisit Pi Durable before expanding the journal into general task scheduling,
   forks, distributed fencing or a second conversation database. Prefer adopting
   its native durable tasks if that migration becomes smaller than maintaining
   equivalent machinery. Self-hosted storage remains mandatory; no Vercel service,
   Sandbox, gateway or managed World is required by this decision.

The live service is never restarted by this prototype proof or its rollout checks.
