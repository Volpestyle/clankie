/**
 * How often a live draft may leave the captain
 * ([ADR 0141](../../../../docs/adr/0141-the-console-watches-him-type.md)).
 * Roughly sixteen frames a second: fast enough to read as typing, slow enough
 * that a parked tail answers on a rhythm rather than on every token.
 */
const OPERATOR_DRAFT_INTERVAL_MS = 60;

/**
 * Paces live drafts. Pi hands over a token at a time and every draft carries
 * the whole message so far, so dropping one costs nothing and sending all of
 * them would answer a parked tail hundreds of times a second. `reset` opens the
 * gate again so the first token of a new message shows up at once.
 */
export function createDraftPacer(
  emit: (text: string) => void,
  options: { readonly intervalMs?: number; readonly now?: () => number } = {},
): { push(text: string): void; reset(): void } {
  const intervalMs = options.intervalMs ?? OPERATOR_DRAFT_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let lastAtMs: number | undefined;
  return {
    push(text: string): void {
      const at = now();
      if (lastAtMs !== undefined && at - lastAtMs < intervalMs) return;
      lastAtMs = at;
      emit(text);
    },
    reset(): void {
      lastAtMs = undefined;
    },
  };
}
