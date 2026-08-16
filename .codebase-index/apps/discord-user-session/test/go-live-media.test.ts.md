# apps/discord-user-session/test/go-live-media.test.ts

Exercises the Go Live publisher with a fake
module pair so no GPL code is imported: login →
joinVoice → playStream on start, refusal of a
second concurrent stream, clean stop, encoder
death clearing active state (stop stays
meaningful), token requirement, and the
actionable install hint when the optional stack
is absent.
