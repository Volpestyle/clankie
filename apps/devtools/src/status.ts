import type { DomainEvent } from "@clankie/protocol";
import { explainStatusFromEvents, formatStatusExplain } from "@clankie/status-resolver";

export function statusExplain(events: readonly DomainEvent[], subjectId: string): string {
  const status = explainStatusFromEvents(events, subjectId);
  if (!status) throw new Error(`No status signals found for ${subjectId}`);
  return formatStatusExplain(status);
}
