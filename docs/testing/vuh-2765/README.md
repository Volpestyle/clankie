# Per-speaker voice hearing — VUH-2765

[Issue](https://linear.app/vuhlp/issue/VUH-2765), following
[VUH-2728](https://linear.app/vuhlp/issue/VUH-2728) and Sage's two report notes.
Fresh core worktree `vuh-2765`, based on `1985611d3974a24d4989ed7e674e21d08f10c971`.

Listener loss and open-failure receipts now include the gateway `userId` already
known by the voice session. They add no transcript, audio, display name or provider
message. Hearing tracks each listener separately; another speaker's transcription
cannot recover it. The optional `pipelines.hearing.brokenUserIds` names affected
speakers in headless `clankie discord call`, the TUI call view and doctor.
Answering remains one leg for the shared conversation session.

Consent withdrawal and participant departure retire that listener from the report.
A late failure after revocation cannot reactivate it; renewed consent permits new
observations. Old failures without a user id stay unattributed and conservative
until the next stay. Loss counts and last-loss metadata remain cumulative history.
Scheduled lifetime rotations still count without breaking a healthy listener, and
a rotation does not heal an earlier unresolved failure.

Doctor no longer treats a missing leave receipt alone as proof of a live stay.
With no `endedAt`, idle state suppresses the headline, unknown state requires a
loss within one hour, and an active different stay cannot revive the old one.
An observed active stay can still headline an unresolved older loss. Recorded
ends retain the existing one-hour window; details retain the historical failure.

## Verification

[Structured results and baseline/typecheck logs](clankie://evidence/sha256/089f9c7bc1d708c86a59d9fd031d136f8fe5cf760aea5e6438f7970e37e5388f).

The regression assertions were run before changing production code: **4 failed /
242 passed** across the three affected test files. Failures caught missing speaker
ids on both runtime receipt paths, another speaker clearing a lost listener, and
an unclosed stale stay continuing to headline.

The final focused check passes **256 tests / 5 files**:

- `apps/clankie/test/discord-room-voice.test.ts`
- `packages/discord-presence-core/test/voice-session.test.ts`
- `apps/tui/test/install-doctor.test.ts`
- `apps/tui/test/discord-room-view.test.ts`
- `packages/protocol/test/discord-voice-evidence.test.ts`

The new receipt test uses `DiscordBridgeReceiptStore`, the production projection,
`DiscordRoomVoice.status` and strict protocol parsing. It also serves that status
over a private loopback HTTP listener and reads it through the actual headless
`runDiscordCommand(["call"])` / API client using a test operator token. The shared
TUI formatter names the same affected id. Runtime receipt tests check both speaker
loss and open failure; doctor tests cover speaker naming, idle and old unknown
stays, recent unknown stays, active stays, replacement stays and old ended calls.

| Receipt sequence                        | Observed hearing                  |
| --------------------------------------- | --------------------------------- |
| A lost, B transcribes                   | broken, A named                   |
| A and B lost                            | broken, both named                |
| A transcribes after both were lost      | broken, only B named              |
| B rotates while already broken          | still broken                      |
| B transcribes                           | working, affected-id field absent |
| A rotates while healthy                 | still working                     |
| A lost, consent revoked, late failure   | working; A retired                |
| A opts in, loses listener, then leaves  | working; A retired                |
| Unattributed legacy loss, B transcribes | broken, no invented speaker id    |
| A new stay joins                        | unproven, no inherited losses     |

The service package typecheck and changed-source lint passed. All commands use `clankie heavy`. The root landing
gate runs after the commit; its result and review status are recorded on the issue.

These are receipt/report and scripted runtime-boundary tests. No live Discord
call, provider request, runtime restart, account change or deployment was performed.
The actual hearing/answering call with James remains VUH-2728's live verification.
The test HTTP listener is closed in `finally`; this work leaves no server running.
