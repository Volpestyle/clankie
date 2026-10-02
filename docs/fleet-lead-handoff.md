# Handing a fleet lead to a Mac seat

Status: retained inactive runbook, 2026-09-27. James wants Clankie to oversee a project's lead and steer
through it, not take over its fleet (2026-09-27), so
[VUH-1381](https://linear.app/vuhlp/issue/VUH-1381) now asks Clankie to reach
the PC lead as one extra peer on that project's coordinator instead. Keep this
runbook only for a transfer the owner explicitly asks for. See
[ADR 0198](adr/0198-one-coordinator-reaches-every-fleet.md).

## Preconditions and proof

1. Record the source and destination conversation, coordinator scope, live
   peer generations, outstanding task attempts/fences, inbox leases and
   watch IDs. The source PC coordinator and the destination embedded Mac
   coordinator are separate authorities: this procedure does not copy their
   SQLite databases or migrate live task ownership implicitly.
2. Reserve a disposable recognized PC agent and its exact fleet-qualified
   pane ID. Do not reuse a Rivals working pane. Confirm the existing Herdr
   server; never start, stop or replace it. On the first Windows fleet,
   Herdr is in session 0 and the desktop job bridge is in session 1.
3. Register the fleet with `clankie herdr add`, approve exact remote work
   directories with `clankie runtime workspaces`, and coordinate activation
   with the service owner. Verify list, read, prompt and bounded wait through
   `clankie herdr --connection pc`. Inspect actual response content; a prompt
   receipt or settled status alone is not completion evidence.
4. Run one harmless desktop bridge job that prints its own process session
   ID. Do not start a second desktop driver or restart the bridge as part of
   this check. Retain the output separately from the SSH-session transcript.
5. Select the destination conversation explicitly. Enroll the reserved PC
   worker using `clankie swarm fleet-peer pc NAME --conversation ID --out FILE`.
   This pins the fleet relay to that conversation's embedded coordinator.
   Transfer the private capability file over SSH to a user-only destination;
   never put its contents in transcripts, issues or prompts. Confirm protocol
   compatibility before starting the PC adapter.
6. Confirm the relay reports ready, the remote TCP listener is loopback-only,
   and the named pipe is `\\.\pipe\clankie-swarm-pc`. Send a unique nonce from
   the Mac seat with `swarm_send`; the PC processes it, acknowledges its current
   lease, and replies on the same thread. The Mac processes and acknowledges
   that reply. Retain message IDs, generations and acknowledgment receipts,
   with capabilities redacted. Every call to the existing Rivals external
   coordinator carries its configured Rivals connection name; calls to the
   chosen embedded destination use that destination conversation.
7. Verify a hire explicitly targets `fleet: "pc"` and an approved remote
   directory. A successful local hire does not count. Record the resulting
   remote pane and stop/clean up only workers owned by this verification.
8. Keep the scratch agent working long enough to arm `herdr_watch` on its
   qualified pane ID. Record the persisted watch and owning conversation.
   Ask the lead for the shared restart window; the lead restarts Clankie.
   After restart, verify that same watch resumes and its completion wakes
   the same conversation once. Do not substitute a newly armed watch.

## Scheduled transfer

1. At the agreed quiet point, the PC lead stops dispatching new work and
   records that fact durably. Drain or explicitly reconcile existing attempts
   and leased messages with their current owner. No new Mac dispatch yet.
2. Save the source lead's task results, pending decisions, evidence links,
   working directories and worker identities in a handoff accessible to the
   destination. Finish/cancel source assignments through their coordinator;
   do not create duplicate assignments for still-running source workers.
3. Start the Mac Clankie seat from the GUI session with the selected destination
   conversation. Verify its intended model authentication and coordinator
   identity. Enroll or reconnect destination workers with fresh capabilities;
   old source-coordinator capabilities do not grant destination authority.
4. Recreate needed observation under Clankie's persisted watches, verify it,
   and retire source-process watchers only after coverage is demonstrated.
   The PC lead confirms dispatch retirement; only then does the Mac lead
   accept dispatch authority and send one bounded task with a stable command ID.
5. In an agreed test window, terminate only the disposable seat owned by the
   test while Clankie's service stays running. Restart that seat in the same
   conversation. Verify the persisted watch still delivers and a test message
   is processed and acknowledged without dead-lettering. Inspect attempts
   before retrying dispatch; a timeout is not evidence that dispatch failed.

## Recovery and acceptance

If relay, authentication or watcher proof fails, pause new destination dispatch.
Reconcile outstanding attempts and message leases before either lead resumes.
Returning dispatch to the PC requires explicit acknowledgment that the Mac
lead has stopped; never let both dispatch during recovery. Restore connectivity
without replacing Herdr or copying coordinator state. Keep failed proof records.

Accept a requested transfer only with the remote list/read/prompt/wait transcript, bridge
session proof, acknowledged round trip, remote hire identity, pre/post-restart
watch evidence, and both leads' scheduled transfer acknowledgments. This runbook
records preparation, not proof of a completed transfer or the current status of
the differently scoped VUH-1381.
