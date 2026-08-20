/** Neutralizes mentions, markdown, and C0/C1 control bytes in rendered fields. */
export function sanitizeDiscordText(value: string): string {
  return stripControlBytes(value)
    .replaceAll("@", "@\u200b")
    .replaceAll("\\", "\\\\")
    .replace(/[\\*_`~|>]/g, "\\$&")
    .slice(0, 500);
}

function stripControlBytes(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) as number;
      return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
    })
    .join("");
}
