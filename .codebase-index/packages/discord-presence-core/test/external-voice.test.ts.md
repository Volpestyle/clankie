# packages/discord-presence-core/test/external-voice.test.ts

External-voice port suite over fake realtime and
TTS ports. Covers: closing the ears when the
mouth cannot open; one TTS context per item with
ordered deltas; never sending a bare token (the
every-word-its-own-utterance bug); speaking each
sentence as it completes; flushing an
unpunctuated tail; holding response-done until
the context drains then forwarding it; forwarding
no-speech dones immediately; forcing the done
through on drain timeout; barge-in becoming
context close + a marker item + dropped late
output; releasing held dones on mouth death and
reopening for the next utterance; reporting a
reopen failure while still settling the turn; and
delegating the realtime-only surface (including
screen image items) + closing both on close.
Separate `splitSpeakableUnits`
suite: hold-until-boundary, end-of-buffer
boundaries, decimal/abbreviation safety, long-run
word-break splitting, clause enders.
