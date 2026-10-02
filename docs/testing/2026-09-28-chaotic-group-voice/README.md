# Chaotic group voice: distinct asks and an available room conversation

2026-09-28 · [VUH-1443](https://linear.app/vuhlp/issue/VUH-1443)

Offline verification with injected Discord, Vox, realtime, TTS, and Pi ports.
No service restart, voice join, live provider call, or push was performed.
James owns activation and the three-person live check.

## Decision and scope

One active speaker's handoffs enter the durable room lane at a time. That
speaker's refinements can steer; other people's requests wait for independent
handoffs. This preserves tool ordering and the room's existing history and
trust boundaries. Bounded parallel sessions were considered but would race
shared machine actions and split history. A long or continually refined ask
can delay other people's work; this tradeoff needs a real chaotic call.
Privileged one-shot authority lanes remain one-shot and do not acquire durable
steering merely because an ask arrived through voice.

The realtime room and local music/screen tools do not wait on captain work.
Native responses queue until provider completion; external TTS responses queue
until synthesis drains as well. Each queued room opportunity carries its
original speaker context at dispatch. Each handoff result carries its recipient
in the same tool output, asking Clankie to name them in his own words.

The floor retains five recent engaged speakers for the existing 60-second
window. Direct addresses, taken offers, and pending work refresh the relevant
speaker; unaccepted follow-ups and general assistant speech do not renew the
entire set. Silence and volition budgets remain unchanged. Barge-in retains
speech-level overlap and substantive-transcript requirements.

## Evidence

[Focused test output](focused-tests.txt): **241 passed across six files**.
The tests exercise production voice ingress plus the real durable dispatcher,
with controlled Pi settlement rather than a paid model:

- Alice's ask and refinement share a run; Bob's unrelated weather question and
  Carol's song request each start their own run and own reply.
- A three-speaker session hears crosstalk without spending a response, takes
  Carol's addressed banter, and plays it before Alice's or Bob's result returns.
- Recipient metadata and response receipts remain Alice/Bob, even after Carol
  speaks; distinct function calls have distinct captain delivery ids.
- Five people retain unnamed follow-ups; the sixth evicts the oldest, and
  individual recency expires even while Clankie continues talking.
- Both provider variants queue response requests and preserve dispatch context;
  external TTS holds later responses until the preceding speech drains.
- Failure releases admission, other rooms stay independent, and stale queued
  requests do not execute after their voice conversation closes.

Full workspace validation is recorded in [check summary](check-summary.txt).

[Retained live gate](retained-live-gate.json): the read-only official-bot
`voice-live-proof --json` command inspected 28,364 receipts and returned
**INCOMPLETE** (exit 1). The selected stay has one attributed speaker, zero
explicit consent receipts, and no completed leave. This proves the available
selected stay does not pass the gate; it does not prove that no unretained
historical call ever did. No synthetic receipts were inserted into that log.

## Live work still required

With three consenting humans in one call, ask unrelated questions over each
other, refine one person's long ask, and keep another person bantering while
it runs. Listen for natural recipient naming, missing/doubled answers, correct
interruptions versus fragments/crosstalk, and acceptable queue delay. Confirm
that the model uses each attributed response opportunity for the right person;
unit tests establish the supplied context, not model compliance or audibility.

Retain the ADR 0045 ceremony's positive DAVE, three explicit consents, three
attributed spoken handoffs, overlap/barge-in, clean leave/reconnect, and play
room delivery evidence. The existing gate remains incomplete until then.

## Shared checkout

The initial diff and index were clean. The other agent's latency edits were
already committed in `e421bb42a43b3482c2ec6d4bbcca501a74652c49`; a passive read of
pane `w2H:p4W` confirmed their completed handoff. This change builds on that
commit and preserves the 500 ms silence, preroll, and first-text timing code.
Only explicitly named owned paths were staged. No stash, reset, amend, or push.
