# Joined Claude resume/reset and worker reports

Tracks: https://linear.app/vuhlp/issue/VUH-2128

Slice 2 adds record-based and explicit Claude resume from the original approved
folder, and `--reset` retaining that folder's home chat. Reset archives context,
retires native session IDs, revokes grants and reports prior launches without
closing panes. Explicit departure releases channel presence without deleting
uncertain delivery receipts.

The joined lead can hire native Claude workers into new Herdr panes in its own
folder through the bounded workers adapter. Each grant pins machine, home chat,
native session and observed pane. The local adapter checks the live grant before
allocation/start and the native occupant before admission and bridge traffic.
Worker MCP exposes report/status only. Reports use the existing durable inbox;
lead replies use an exact-ack worker outbox over encrypted join and record that
the report received an answer. No SSH fleet link or owner bearer is used.

## Verification

- 59 focused tests across eight suites: joined seats, machine join, remote lead
  HTTP, conversation reset, seat outbox, Claude launcher/context selection and
  worker-report CLI consumers.
- The joined proof uses real sockets, encrypted challenge/exchange, broker files,
  conversation storage, MCP clients/servers and a real native prompt subprocess.
  It exercises record/explicit resume, retained-chat reset, retired sessions,
  earlier-launch reporting, worker grant/session checks, durable report receipt
  and lookup, lead inbox/acknowledgment, exact-ack reply, and revoked grants.
- A bounded compiler program includes the touched joined service/client flows
  and the integration test, following their transitive consumers. Passed.
- Explicit touched-file formatter/lint and documentation checks passed.
- Raw logs and tested-file hashes are archived through `evidence.json`.
  The integrator owns the separate exact-tree landing gate.

## Gaps

Native Claude lead spawning is observed at the launcher boundary. The worker
proof supplies the native adapter's admission at the encrypted transport boundary;
it does not execute the local Herdr/Claude worker adapter or prove native UI.
That adapter is inspected and typechecked. Real native Windows and production
gateway proof requires James's PC and coordination through the lead. No PC
access, installers, production gateway calls or evals ran in this slice.

Windows packaging/install/update, other harnesses and legacy SSH chat migration
remain open. Old `pc` chats are not implicitly claimed by a new `join-UUID`.
Prior-launch reporting retains up to 32 IDs per chat (up to 256 chats) in this home
process; home restart loses that report list and invalidates all ephemeral grants.
Existing native panes remain open after grant revocation. Joined workers have
report/status tools rather than the general connected-account worker catalog.
