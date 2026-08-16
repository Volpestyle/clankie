# packages/discord-presence-core/src/voice-address.ts

Recognizing Clankie's name in a _transcript_,
where the transcriber invents spellings
("clanky", "klankie") that literal matching
misses — and a missed wake is the worse social
failure (ADR 0057).

- `phoneticKey(word)` — conservative consonant
  skeleton: digraph folds (ph→f, ck→k, soft c→s),
  interior vowels dropped (leading vowel kept),
  doubled letters collapsed. Keeps "blankie"
  distinct from "clankie" and gets word-boundary
  safety for free.
- `voiceAddressesCharacter(transcript, names)` —
  the voice-plane counterpart of
  `addressesCharacter`, matching tokenized words
  (possessives stripped) by phonetic key.
- `releasesFloor(transcript, names)` — explicit
  floor handback: a small closing-word set
  (thanks/bye/nvm…) within 3 tokens of any
  mention of his name, so "thanks" aimed at
  someone else never dismisses him. A fast path
  over the decay window, never the mechanism.
- `addressKeys(names)` — the phonetic key set.
