/** Authored external-voice directions only; never apply this to human input or generic messages. */
export const VOICE_TONE_TAGS = [
  "laughs",
  "chuckles",
  "sighs",
  "whispers",
  "sarcastic",
  "excited",
  "curious",
  "deadpan",
] as const;
export const VOICE_TONE_CAPABILITY = `Your external voice supports these inline delivery tags: ${VOICE_TONE_TAGS.map((tag) => `[${tag}]`).join(", ")}. Tags direct the spoken performance and are omitted from readable transcripts. Square-bracket directions are voice markup; other directions are not supported.`;
const allowed = new Set<string>(VOICE_TONE_TAGS);
const MAX_TAG_CHARACTERS = 64;

/** Incremental, bounded bracket state; a partial/unknown direction never escapes either projection. */
export class VoiceToneText {
  private depth = 0;
  private tag = "";
  private invalid = false;
  private started = false;
  private space = false;
  private readonly expressive: boolean;
  public constructor(expressive: boolean) {
    this.expressive = expressive;
  }

  public append(delta: string): { speech: string; readable: string } {
    let speech = "",
      readable = "";
    for (const character of delta) {
      if (this.depth > 0) {
        if (character === "[") {
          this.depth++;
          this.invalid = true;
        } else if (character === "]") {
          this.depth--;
          if (this.depth === 0) {
            if (!this.invalid && this.expressive && allowed.has(this.tag)) speech += `[${this.tag}]`;
            this.tag = "";
            this.invalid = false;
          }
        } else if (!this.invalid) {
          if (this.tag.length < MAX_TAG_CHARACTERS) this.tag += character;
          else {
            this.tag = "";
            this.invalid = true;
          }
        }
        continue;
      }
      if (character === "[") {
        this.depth = 1;
        continue;
      }
      // Stray closers cannot turn a dropped malformed direction into provider markup.
      if (character === "]") continue;
      speech += character;
      if (/\s/u.test(character)) {
        if (this.started) this.space = true;
      } else {
        readable += (this.space ? " " : "") + character;
        this.space = false;
        this.started = true;
      }
    }
    return { speech, readable };
  }
}
