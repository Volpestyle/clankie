# Visible parallel room handoffs — VUH-1672

Work: [VUH-1672](https://linear.app/vuhlp/issue/VUH-1672).
Decision: [ADR 0229](../../adr/0229-room-handoffs-are-visible-parallel-threads.md).
Base: batch 16 `b68678e8`, containing voice fix `db82f6d8`.

Each admitted voice/text handoff owns a saved child conversation with the asking
actor, original room, delivery ID, request, work, state and result. The service
admits four children concurrently. Each Pi child has its own real session file;
native children require verified parent/task ancestry. Cards in the TUI and app
select the saved child instead of manufacturing fleet seats.

Execution follows the live head. Claude children use the plugin's restricted
`clankie:room` agent and scoped proxy tools. Machine-authorized Codex work uses
real native children. Ambient work with a Codex head runs as Pi children under
the original room lane. Codex 0.160.0 retains parent MCP and permissions and has
no public child `ToolPolicy` API; the ADR records the upstream request.

## Focused verification

Focused results: **18 core files, 287 tests passed** (56 service and 231
voice/TUI). These checks use temporary stores, loopback providers and native
transcript fixtures, without real Linear writes, sign-ins, evaluations or a
full `pnpm check`.

```sh
pnpm exec vitest run --config vitest.config.ts \
  apps/clankie/test/room-handoff-pi.integration.test.ts \
  apps/clankie/test/native-room-handoff.integration.test.ts \
  apps/clankie/test/room-handoff-native-captain.integration.test.ts \
  apps/clankie/test/hosted-room-handoff.integration.test.ts \
  apps/clankie/test/captain-room-guidance.test.ts \
  apps/clankie/test/captain-room-seat.test.ts \
  apps/clankie/test/room-conversations.test.ts \
  apps/clankie/test/seat-outbox.test.ts \
  apps/clankie/test/operator-conversation-seat.test.ts \
  apps/clankie/test/operator-conversation-head.test.ts \
  apps/clankie/test/discord-ingress.test.ts \
  apps/clankie/test/discord-room-routes.test.ts

pnpm exec vitest run --config vitest.config.ts \
  packages/discord-presence-core/test/voice-ingress.test.ts \
  packages/discord-presence-core/test/voice-session.test.ts \
  apps/tui/test/live-agents.test.ts \
  apps/tui/test/herdr-roster.test.ts \
  apps/tui/test/conversations-cli.test.ts \
  apps/tui/test/seat-context-selection.test.ts
```

All four affected package typechecks passed:
`pnpm --filter @clankie/clankie typecheck`,
`pnpm --filter @clankie/protocol typecheck`,
`pnpm --filter @clankie/tui typecheck`, and
`pnpm --filter @clankie/discord-presence-core typecheck`.
Owned source/test files passed `oxlint --deny-warnings` and all owned paths
passed `oxfmt --check`. Both native plugin generators passed `build.mjs --check`.
`git diff --check`, the local documentation link and retired-claim checks, and
`pnpm docs:public:check` passed.

The new boundary evidence is:

- [Pi execution](../../../apps/clankie/test/room-handoff-pi.integration.test.ts):
  actual Pi sessions, extensions, tool banks and session files with a loopback
  HTTP/SSE provider. Four concurrent sessions, fifth-in FIFO, separate actors
  and destinations, exact retries/conflicts, original grant ceilings and
  revocation, authenticated hosted owner proof and restart retention.
- [Production native activation](../../../apps/clankie/test/room-handoff-native-captain.integration.test.ts):
  actual Captain constructor, authenticated transcript upload, fresh fleet
  census, parent poll/ACK, lane MCP transport and native ancestry fixtures.
  Claude and machine Codex each admit two children; the second completes while
  the first remains pending, with no Pi session initialized. The parent never
  receives the original room request; only the verified child catalog does.
- [Scoped native tools](../../../apps/clankie/test/native-room-handoff.integration.test.ts):
  real HTTP lane MCP and native journals reject forged capabilities, foreign
  ancestry, unrestricted Claude agent types, revoked grants and late completion.
  Child transcripts and approval-shaped completion remain tied to their room.
- [Hosted ingress](../../../apps/clankie/test/hosted-room-handoff.integration.test.ts):
  generated test Ed25519 keys, real signed/encrypted HTTP and credential files.
  Unsigned owner claims fail; approval prompts use the authenticated-surface
  handoff; exact retries survive restart; closing ingress invalidates host proof.
  A CaptainPort boundary fixture complements the real Captain/Pi authority test.

The private app has its own focused evidence record at
`clankie-app/docs/testing/2026-10-05-room-handoffs/README.md`. It covers metadata
propagation and exact child selection at phone and tablet sizes. It does not
claim a native build or simulator/device verification.

## James's real multi-person verification

Run after Pell lands both core and app commits, using the resulting build. This
is product verification in a real Discord call, not an automated model eval.
Use only test panes you open; leave unrelated fleet sessions running.

1. Save `clankie status`, `clankie discord setup`, `clankie discord call` and
   `clankie conversations list` output. Choose an allowlisted voice room with
   James and at least two consenting friends. Confirm a friend's account has
   **no** individual, channel or server computer grant; James remains the owner.
   Use the configured consent policy. Record the room and stay IDs. No new
   sign-in is needed. Keep a TUI and the app observing the same service.
2. First use the service's Pi head. Friend A says: “Clankie, compare asyncio and
   threads for Python network work using three primary sources; call this A.”
   While that handoff is working, friend B says: “Clankie, research how file
   locks work across processes using three primary sources; call this B.”
   Confirm A and B appear as distinct **Working** cards simultaneously, with
   different actor IDs and child IDs. Their results must stay attached to the
   correct card and asking voice room. Speech can serialize or offer a late
   result when the room moves on; it must never attribute B's answer to A.
3. While A runs, B makes a new handoff with exactly A's wording. Confirm it is
   a new child. Ask A to explicitly join A's pending ask and verify the original
   child is retained; another speaker cannot join or steer it. A retry of the
   same transport call must not create another execution.
4. To observe the bound, have five people request separate multi-source jobs
   in quick succession while the first four remain active. Expect at most four
   **Working** cards and the fifth **Queued**, then its admission when a slot
   frees. Save the corresponding conversation metadata and timestamps. If the
   jobs finish too quickly to overlap, repeat with longer research requests;
   lack of overlap alone does not prove queue failure.
5. In a second allowlisted Discord text room, mention Clankie with another
   research request marked “TEXT-B”. Its card must say **Discord**, run alongside
   the voice work, and return to that text room. Open A, B and TEXT-B in both
   the dock and app; each must replay only its own request, tool work and result.
   Check the phone and tablet layouts when available.
6. Open a test head with `clankie claude --conversation global-default`. Wait
   for its channel to be live, then repeat A and B. Claude must show two native
   background `Agent` calls with `subagent_type: clankie:room`. The dock/app
   executor becomes **Claude** only after the real child reference is observed.
   The restricted child can reach only `room_task_tools`, `room_task_call` and
   `room_task_complete`; its advertised bank is the original room's bank.
7. End that test seat and open
   `clankie codex --conversation global-default`. Repeat the ungranted friends'
   requests: the cards must show **Pi**, run concurrently and retain social room
   tools, while the head remains Codex. Then James asks for a harmless machine
   task, such as printing the current directory and returning it to the room.
   Expect a real native Codex `spawn_agent`, an actual child reference and a
   **Codex** executor card for James's request.
8. An ungranted friend asks Clankie to write
   `/tmp/vuh-1672-ambient-proof.txt` with Bash, then says “I approve”. Confirm
   the child has no shell/file-write tool and the file is absent. Any
   approval-shaped result must direct the requester to the authenticated
   operator surface; ambient speech/text cannot settle privileged approval.
   Do not approve a mutation just to complete this check.
9. With four jobs active, queue a job from a separately machine-granted test
   friend, remove that friend's grant in Discord setup **before** its admission,
   and confirm it cannot execute machine tools. Restore the original grant
   configuration afterward. End only the native test seats you opened.
10. Attach bounded evidence to VUH-1672: build/core/app SHAs; head and room IDs;
    A/B/TEXT-B child IDs, executor/state transitions and results; native child
    IDs; the queued fifth job; approval refusal; and observed timing. Existing
    opt-in voice transcripts can add exact words; enabling retention is a
    separate explicit owner choice. Do not attach credentials or raw audio.

Automated coverage does not establish live Claude/Codex model compliance,
provider timing, Discord playback, or native app rendering. Those remain the
limits this manual pass resolves. A service interruption fails unfinished
handoffs visibly and never silently repeats uncertain native work.
