# packages/discord-presence-core/test/voice-consent.test.ts

Consent registry suite: explicit policy permits
only session-bound opt-ins and forgets them on
channel exit; an invoker-less open (asked join)
permits nobody until explicit opt-in; consent
refused outside the active guild/channel;
presence policy consents the room, only in the
active channel, never a refuser (refusal
outlives rejoin); `permitted` reports the room
under presence rather than the empty opt-in
list, and stays the explicit list regardless of
occupants under explicit.
