# Discord voice arrival choice — 2026-09-28

[VUH-1441](https://linear.app/vuhlp/issue/VUH-1441/let-clankie-choose-how-he-arrives-in-discord-voice).
Root: `/Users/james/dev/clankie`, shared checkout on `main`.
Implementation: `68decfb68ef941ac51e982c1b06f138214b68101` (read with
`git rev-parse HEAD` after commit). Offline tests with fake model, Discord,
provider socket and audio transports; no service restart or live voice join.

## Cause and change

The join tool did not describe a text acknowledgement as optional, and the
voice session offered no turn on its own arrival. The reported stay `97b29808`
joined at 23:10:28 UTC and first requested a model response at 23:10:44,
after a human spoke. The playback response receipt followed at 23:10:53.
The existing silent sentinel already suppressed text delivery; it needed no
new reply filter.

The text tool now describes text, silence, and a possible voice greeting as
choices. The host copies the asking message (at most 1,000 characters) through
the shared loopback control request. Both bodies supply the resolved asker;
the official bot leaves consent unchanged and the lab body retains its existing
owner consent. Once transport, DAVE, and the transcription probe are ready,
a self-arrival observation offers the existing `membership` turn with the room
roster. Invitation text and names are untrusted context. No human actor is
assigned to that turn, so `ask_clankie` cannot borrow the asker's authority.

## Evidence

[Focused tests](evidence/focused-tests.txt): 8 files, 155 tests passed on the
shared working tree, including the other agent's contemporaneous latency tests.
The arrival tests prove:

- Host-copied invitation bounds and argument-free identity; both active-body
  client routes preserve the text, and the control endpoint rejects invalid
  or oversized context.
- The bot's authorized join carries the invitation and stays idempotent. The
  lab body's source-wiring check keeps invitation context separate from its
  existing owner-consent argument; this is not a live lab-body test.
- The voice model receives the roster, resolved asker, and bounded JSON-quoted
  invitation before anyone speaks. Fake model choices exercise silence and
  actual PCM playback, receipted with `trigger: membership`.
- Neither the asker nor another unconsented occupant is subscribed, even after
  a speaking event. The arrival cannot invoke privileged work for the asker.
- An arrival that finishes opening after departure creates no response.
- Existing silent-sentinel handling, speech, membership, and consent regressions.

## Verification log

The first focused run exposed fixtures that assumed joins never opened a
conversation. Fixtures now explicitly settle a silent arrival and expire its
hold before exercising later wakes; the arrival cases inspect the fresh turn.

The first `pnpm check` stopped at formatting in other agents' in-flight files.
A concurrent typecheck briefly saw `external-voice.ts` calling `onFirstText`
before its interface landed, and a later focused run caught the other lane's
500ms capture endpoint before its old 800ms assertion was updated. No arrival
assertion failed in that run. Those edits were preserved, and the subsequent
focused run and full typecheck passed. Only arrival hunks were staged in the
shared session, session tests, and tracing skill.

[Final `pnpm check`](evidence/workspace-check.txt) passed on the shared working
tree: 27 typecheck tasks, 353 JavaScript test files, 2,965 tests passed and 2
skipped, 123 Rust tests, and the Vox IPC smoke test. Formatting, lint, dead-code,
docs and infrastructure checks also passed. The added archive passed a separate
`pnpm docs:check`; no arrival implementation changed after that full check.

## Re-run

```sh
pnpm exec vitest run --config vitest.config.ts \
  packages/discord-presence-core/test/voice-session.test.ts \
  packages/discord-presence-core/test/voice-control.test.ts \
  apps/clankie/test/captain-voice-presence.test.ts \
  apps/clankie/test/discord-voice-presence.test.ts \
  apps/discord-bridge/test/voice-presence.test.ts \
  apps/discord-bridge/test/voice-realtime-wiring.test.ts \
  apps/discord-user-session/test/wiring.test.ts \
  apps/clankie/test/discord-durable-room.test.ts
pnpm check
```

## Limits

These are capability and scheduling tests, not a prediction that the live model
will choose a particular greeting or silence. The text and voice turns decide
independently; both may speak. Opening the arrival conversation can incur model
usage even if he stays quiet. James owns activation and the live check.
