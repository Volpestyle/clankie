/** Decode one CLIXML text value without interpreting escaped text a second time. */
function decodeCliXmlText(value: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return (
    value
      .replace(
        /&(?:#(x[\da-f]+|\d+)|(amp|lt|gt|quot|apos));/giu,
        (entity: string, numeric: string | undefined, name: string | undefined) => {
          if (name !== undefined) return entities[name.toLowerCase()] ?? entity;
          if (numeric === undefined) return entity;
          const codePoint = numeric.toLowerCase().startsWith("x")
            ? Number.parseInt(numeric.slice(1), 16)
            : Number.parseInt(numeric, 10);
          return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
        },
      )
      // `_x005F_x0041_` represents the literal `_x0041_`, so this must be one pass.
      .replace(/_x([\da-f]{4})_/giu, (_escape: string, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
  );
}

/** Keep plain stderr and PowerShell error records, omitting its progress serialization. */
export function decodeRemoteShellError(stderr: string): string {
  return stderr
    .replace(/#<[^\S\r\n]*CLIXML[^\S\r\n]*(?:\r?\n|$)/giu, "")
    .replace(/<Objs\b[^>]*>([\s\S]*?)(?:<\/Objs\s*>|$)/giu, (_document: string, body: string) => {
      const errors: string[] = [];
      for (const record of body.matchAll(/<S\b([^>]*)>([\s\S]*?)<\/S\s*>/giu)) {
        if (/\bS\s*=\s*(["'])Error\1/iu.test(record[1] ?? "")) {
          const error = decodeCliXmlText(record[2] ?? "").trim();
          if (error) errors.push(error);
        }
      }
      // Old captured failures can end mid-progress record. Drop that framing
      // too, after extracting every complete error record that preceded it.
      return errors.join("\n");
    })
    .replace(/\r\n?/gu, "\n")
    .replace(/^clankie-launch-[\da-f]{16}: /gmu, "")
    .trim();
}
