# packages/discord-presence-core/test/voice-session.test.ts

The largest suite: the full media owner over
fake realtime ports, an injected clock/timers,
and stubbed @discordjs/voice plumbing.

Lifecycle: DAVE join opening the dormant listener
and reporting two-tier status; asked joins opting
in nobody; join failing (and leaving cleanly)
when the listener cannot open; leave closing both
sessions, cancelling timers, zeroing the ring;
post-leave callbacks ignored. Consent boundary:
unconsented participants never subscribed,
mid-capture revocation destroying the capture,
channel exit revoking. Audio path: streamed
conversion with source zeroing and utterance
receipts, append-cap slicing, conversation copies
only while engaged (not in the hold window).
Floor decisions: addressed wake briefs/opens/
seeds ring-then-briefing/announces/responds;
holder continuation reusing the session; dormant
crosstalk opening nothing; explicit release
keeping the session warm until the hold expires;
wake-inside-hold skipping setup; timer-tick
decay. Volition: taken offers engaging on the
provoking speaker with accounting; decider errors
counted as suppressed. Speaker attribution from
gateway spans with announced changes. Fast-path
responses: toFirstAudioMs/playbackMs receipts,
waking-then-continuing, playback buffers zeroed.
Ability path: serialized ask_clankie with
evidence, authenticated-surface handoff for
approvals, fixed-sentence captain failures,
malformed arguments rejected without hanging,
silent outcomes saying/receipting nothing.
Barge-in: sustained holder speech truncating at
the played offset, re-address truncating and
moving the floor, non-holder crosstalk never
truncating. Reconnect: lost listener backing off
and reopening, lost conversation reopening lazily
on the next wake. Transcript ring capping.
Possessor narration (ADR 0064): refusing outside
a channel and on empty reports, seeding as
context, rate-limiting responses within the
narration interval, pushing attributed lines only
for consented speech, surviving throwing
subscribers, and collapsing un-awaited bursts to
one response.
