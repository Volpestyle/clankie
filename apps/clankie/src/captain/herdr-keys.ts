// Herdr's `pane send-keys` names fewer keys than a connected app may press
// (ADR 0323). Herdr 0.9.3 refuses home, end, pageup, pagedown and delete as
// `invalid_key`, so those go in as the bytes an xterm sends for them, through
// `pane send-text`, which passes escape bytes as they are. Every other key
// keeps going by name.

const CSI = "\u001b[";
/** xterm's final byte or `~` code for each key Herdr has no name for. */
const XTERM_KEYS: Readonly<Record<string, { readonly final: string } | { readonly code: number }>> = {
  home: { final: "H" },
  end: { final: "F" },
  pageup: { code: 5 },
  pagedown: { code: 6 },
  delete: { code: 3 },
};
const MODIFIER_BITS: Readonly<Record<string, number>> = { shift: 1, alt: 2, ctrl: 4 };

/** The bytes an xterm sends for a key Herdr can't press by name, or undefined for one it can. */
function xtermKeySequence(key: string): string | undefined {
  const parts = key.split("+");
  const xterm = XTERM_KEYS[parts.at(-1) ?? ""];
  if (xterm === undefined) return undefined;
  const bits = parts.slice(0, -1).reduce((sum, modifier) => sum + (MODIFIER_BITS[modifier] ?? 0), 0);
  // xterm names a modifier set as 1 + its bits: ctrl+pageup is CSI 5;5~.
  const modifier = bits === 0 ? undefined : String(1 + bits);
  if ("final" in xterm)
    return modifier === undefined ? `${CSI}${xterm.final}` : `${CSI}1;${modifier}${xterm.final}`;
  return modifier === undefined ? `${CSI}${String(xterm.code)}~` : `${CSI}${String(xterm.code)};${modifier}~`;
}

/** Keys in order, as runs Herdr presses by name and sequences it types. */
export function herdrKeyRuns(
  keys: readonly string[],
): readonly ({ readonly keys: readonly string[] } | { readonly text: string })[] {
  const runs: ({ keys: string[] } | { text: string })[] = [];
  for (const key of keys) {
    const sequence = xtermKeySequence(key);
    const last = runs.at(-1);
    if (sequence !== undefined) runs.push({ text: sequence });
    else if (last !== undefined && "keys" in last) last.keys.push(key);
    else runs.push({ keys: [key] });
  }
  return runs;
}
