# VUH-2258: stage full-size Windows Codex queue messages

## Scope

Only one PC delivery path carries a message body as a command-line argument:
`codex queue --thread ID --message <text>`, remoteCodexQueue's fallback for an
adopted Codex session in its default home on Windows. `codex queue` has no
stdin or file option, and on Windows `codex.js` passes its arguments on to the
native binary, so a full 32,768-character message exceeds the 32,767-character
process command line (VUH-2135's boundary probe). PC Claude seats receive
through the fleet mailbox over HTTP, and Codex seats Clankie hired receive
through their private app-server as JSON over the streamed SSH lane; neither
puts the body on a command line.

## Change

When the queue command line would exceed 30,000 characters, remoteCodexQueue
first writes the exact UTF-8 body to
`%USERPROFILE%\.clankie\seat-messages\<uuid>.md` inside a PowerShell script
(the script itself crosses SSH stdin, VUH-2135), which reports the written
file's SHA-256. Only a matching hash queues a short pointer: the message's
length, path and SHA-256, and an instruction to read the whole file as the
message. A failed or mismatched staging returns undelivered/unavailable with
nothing queued. Files older than a week are pruned on each write. Shorter
messages and POSIX machines are unchanged.

## Proof

- `remote-codex-app-server.test.ts`: a 32,768-character Unicode message stages
  its exact bytes and queues a pointer under the bound; a hash mismatch queues
  nothing. Both fail without the change.
- Real PC (`volpe@supedupsilly`), opt-in `fleet-pc-payload.integration.test.ts`,
  three passing runs ([records](records/pc-proof.jsonl)):
  - Baseline: the same 32 KB message as a raw `node codex.js queue` argument is
    refused by Windows (`definitive: not_sent`).
  - Through remoteCodexQueue: staged at `C:\Users\volpe\.clankie\seat-messages\…`
    with the PC-computed SHA-256 `f3e56158…` equal to the sent bytes; then the
    real `node codex.js queue` started with the pointer, and Codex itself
    answered `no rollout found for thread id …` (each run used a fresh thread
    UUID, so no session received anything). The test read the file back on
    the PC, matched its hash, and removed it.
  - One earlier run, before the records were kept, failed at the staging step
    after 35 seconds and could not be reproduced; a staging failure returns
    not-sent with nothing queued.

## Not run

The planned 32 KB and 20 KB message_seat pass to a throwaway hired PC Claude
seat did not run: the lead's hire returned `delivery_unconfirmed` for a pane
that does not exist, with no receipt to settle, and was not retried. That path
(fleet mailbox) and the hired-Codex app-server path carry the body off the
command line. VUH-2135's ~20 KB live observation stays open.
