# packages/discord-presence-core/src/voice-address.ts

Phonetic recognition of Clankie's name in noisy
transcripts (ADR 0057).

- `phoneticKey(word)` folds common transcription
  variants (ph→f, ck→k, soft c→s), removes
  interior vowels, and collapses doubles while
  retaining consonant distinctions such as
  blankie vs clankie.
- `addressKeys(names)` builds the configured key
  set.
- `voiceAddressesCharacter(transcript, names)`
  matches tokenized, possessive-stripped words
  with word-boundary safety.

There is no closing-word detector: "thanks,
clankie" remains an address. Floor release is
owned solely by decay in `voice-floor.ts`.
