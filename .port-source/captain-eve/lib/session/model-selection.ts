import type { CaptainContextBudget } from "./context-budget.ts";

export interface CaptainModelSelection {
  readonly ref: string;
  readonly budget?: CaptainContextBudget;
}

const MAX_SELECTIONS = 256;
const selections = new Map<string, CaptainModelSelection>();

function selectionKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

export function rememberModelSelection(
  sessionId: string,
  turnId: string,
  selection: CaptainModelSelection,
): void {
  const key = selectionKey(sessionId, turnId);
  selections.delete(key);
  selections.set(key, selection);
  while (selections.size > MAX_SELECTIONS) {
    const oldest = selections.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    selections.delete(oldest);
  }
}

export function modelSelectionForTurn(sessionId: string, turnId: string): CaptainModelSelection | undefined {
  return selections.get(selectionKey(sessionId, turnId));
}
