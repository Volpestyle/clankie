/**
 * Recognizing his own name in a transcript.
 *
 * The text plane matches names literally, which is correct there: a person who
 * types "clankie" typed it. Speech is different — the name reaches this code
 * through a transcription model that has never seen it, and comes out
 * "clanky", "clankee", "klankie", or "clanki" depending on the speaker.
 * Literal matching therefore misses a large share of the times he was actually
 * addressed, and a missed wake is the worse social failure: ignoring someone
 * who spoke to you reads as broken in a way that an occasional stray reply does
 * not.
 *
 * Steering the transcriber would be the better fix and is not available:
 * `prompt` is unsupported for `gpt-realtime-whisper` in GA Realtime sessions,
 * so the name cannot be biased at the source ([ADR 0057](../../../docs/adr/0057-realtime-voice-with-captain-handoff.md)).
 *
 * The tolerance deliberately lives here rather than in `persona.aliases`.
 * Aliases are owner-authored nicknames and they feed the **text** plane through
 * the same `characterNames()`; loading them with transcription artifacts would
 * make Discord text ingress fire on spellings no human would ever type.
 */

/**
 * Reduce a word to a consonant skeleton that survives the vowel and ending
 * variance a transcriber invents around an unfamiliar proper noun.
 *
 * Deliberately conservative. Vowels and word endings are what speech-to-text
 * actually gets wrong on a name it does not know; it rarely swaps the leading
 * consonant. Dropping vowels therefore buys the tolerance that matters, while
 * keeping every consonant means "blankie" stays distinct from "clankie" and
 * "clankiest" still does not summon him — the same word-boundary property the
 * text plane gets from `addressesCharacter`, here for free.
 */
export function phoneticKey(word: string): string {
  const letters = word.toLowerCase().replaceAll(/[^a-z]/gu, "");
  if (letters.length === 0) return "";
  let mapped = letters
    .replaceAll("ph", "f")
    .replaceAll("gh", "")
    .replaceAll("ck", "k")
    .replaceAll("ch", "k")
    .replaceAll("sh", "s")
    .replaceAll("th", "t")
    // Soft c is an s sound; every other c is a k. Doing this before the bare
    // consonant folds below keeps "clankie" and "klanky" on the same key.
    .replaceAll(/c(?=[eiy])/gu, "s")
    .replaceAll("c", "k")
    .replaceAll("q", "k")
    .replaceAll("x", "ks")
    .replaceAll("z", "s")
    .replaceAll("v", "f")
    .replaceAll("y", "i");
  // A leading vowel is kept because it is audible and distinguishing; interior
  // vowels are exactly the part a transcriber guesses at.
  const leading = /^[aeiou]/u.test(mapped) ? (mapped[0] ?? "") : "";
  mapped = mapped.replaceAll(/[aeiou]/gu, "");
  const skeleton = leading + mapped;
  // Doubled letters are a spelling artifact, never a distinct sound.
  return skeleton.replaceAll(/(.)\1+/gu, "$1");
}

/**
 * Split a transcript into comparable word tokens.
 *
 * Possessives are stripped so "clankie's" still addresses him; without it the
 * trailing s lands in the skeleton and the match fails on a phrasing people
 * use constantly.
 */
function tokenize(transcript: string): string[] {
  return transcript
    .toLowerCase()
    .replaceAll(/['’]s\b/gu, "")
    .split(/[^a-z]+/u)
    .filter((token) => token.length > 0);
}

/** Phonetic keys for every name he answers to, empty keys discarded. */
export function addressKeys(names: readonly string[]): ReadonlySet<string> {
  return new Set(names.map((name) => phoneticKey(name)).filter((key) => key.length > 0));
}

/**
 * Was he spoken to?
 *
 * The voice-plane counterpart to `addressesCharacter`. Same question, same
 * source list from `characterNames(persona)`, matched phonetically because the
 * transcript is a guess rather than something a person typed.
 */
export function voiceAddressesCharacter(transcript: string, names: readonly string[]): boolean {
  const keys = addressKeys(names);
  if (keys.size === 0) return false;
  return tokenize(transcript).some((token) => keys.has(phoneticKey(token)));
}
