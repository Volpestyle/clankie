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

interface TranscriptToken {
  readonly word: string;
  readonly possessive: boolean;
}

/**
 * Split a transcript into comparable word tokens.
 *
 * Possessives stay marked so "clankie's job" can be told from talking to him.
 * The stem still keys as "clankie".
 */
function tokenize(transcript: string): TranscriptToken[] {
  const tokens: TranscriptToken[] = [];
  for (const raw of transcript.toLowerCase().split(/[^a-z'’]+/u)) {
    if (raw.length === 0) continue;
    const possessive = /['’]s$/u.test(raw);
    const word = possessive ? raw.slice(0, -2) : raw.replaceAll(/['’]/gu, "");
    if (word.length === 0) continue;
    tokens.push({ word, possessive });
  }
  return tokens;
}

const VOCATIVES = new Set(["hey", "hi", "yo", "ok", "okay", "oh", "and", "so"]);
/** After the name, these make "Clankie is broken" look like a report, not a hail. */
const THIRD_PERSON_AFTER_NAME = new Set(["is", "was", "has", "had", "does", "did", "just"]);
const ABOUT_VERBS = new Set([
  "ask",
  "asked",
  "asking",
  "tell",
  "told",
  "telling",
  "show",
  "showed",
  "showing",
  "call",
  "called",
  "calling",
]);

/** Phonetic keys for every name he answers to, empty keys discarded. */
export function addressKeys(names: readonly string[]): ReadonlySet<string> {
  return new Set(names.map((name) => phoneticKey(name)).filter((key) => key.length > 0));
}

export type VoiceAddressKind = "addressed" | "mentioned" | "none";

/**
 * How his name landed in a transcript.
 *
 * `addressed` is a clean hail. `mentioned` is a name hit that is not clearly
 * about him — including the name-first questions a word list would drop.
 * `none` is possessive or ask/tell-object, and nothing else: it is the only
 * bucket he is never offered a turn on, so it demands positive evidence the
 * room is talking *about* him. Inferring a second addressee from word order
 * cannot supply that — no other name is in evidence, and every discourse
 * marker people open a sentence with ("so what do you think clankie") reads
 * as one. Ambiguity resolves to `mentioned`, where he decides for himself; a
 * wrong `mentioned` costs one declined turn, a wrong `none` drops an address.
 */
export function classifyVoiceAddress(transcript: string, names: readonly string[]): VoiceAddressKind {
  const keys = addressKeys(names);
  if (keys.size === 0) return "none";
  const tokens = tokenize(transcript);
  if (tokens.length === 0) return "none";
  const nameHits: { readonly index: number; readonly possessive: boolean }[] = [];
  for (const [index, token] of tokens.entries()) {
    if (keys.has(phoneticKey(token.word))) nameHits.push({ index, possessive: token.possessive });
  }
  if (nameHits.length === 0) return "none";

  let mentioned = false;
  for (const hit of nameHits) {
    const previous = hit.index > 0 ? tokens[hit.index - 1]?.word : undefined;
    const after = tokens[hit.index + 1]?.word;
    const vocative = previous !== undefined && VOCATIVES.has(previous);
    const aboutObject = previous !== undefined && ABOUT_VERBS.has(previous);
    const first = hit.index === 0 || (hit.index === 1 && vocative);
    const last = hit.index === tokens.length - 1;
    const thirdPerson = after !== undefined && THIRD_PERSON_AFTER_NAME.has(after);
    if (aboutObject) continue;
    if (hit.possessive && !last && !vocative) continue;
    if (vocative || (first && !thirdPerson) || last) return "addressed";
    mentioned = true;
  }
  return mentioned ? "mentioned" : "none";
}

/**
 * Did his name come up at all? Barge-in and receipts still need a boolean.
 * Speech autonomy uses {@link classifyVoiceAddress}.
 */
export function voiceAddressesCharacter(transcript: string, names: readonly string[]): boolean {
  return classifyVoiceAddress(transcript, names) !== "none";
}
