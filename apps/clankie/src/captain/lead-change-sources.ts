import { readDesktopLeadChanges } from "./herdr-core.ts";
import type { AppNotesReadInput } from "./fleet-room.ts";
import type { AppNotesResult } from "@clankie/protocol";
import type { ConversationStore } from "./conversations.ts";
import type { LeadStore } from "./lead.ts";
import { leadChangeRecord, type LeadChangeSnapshot } from "../lead-changes.ts";

/** The same canonical selections as inbox/reports/notes, without report-offer or answer writes. */
export async function leadChangeSources(input: {
  readonly conversations: ConversationStore;
  readonly lead: LeadStore;
  readonly notes: (input: AppNotesReadInput) => Promise<AppNotesResult>;
  readonly deviceId?: string;
  readonly visibleQuestion?: (
    question: NonNullable<ReturnType<ConversationStore["pendingLeadQuestions"]>[number]["question"]>,
  ) => Promise<boolean>;
}): Promise<LeadChangeSnapshot[]> {
  const visible = (id: string) => {
    const kind = input.conversations.conversation(id)?.scope.kind;
    return kind === "global" || kind === "workspace";
  };
  const reports = input.conversations
    .inboundReports(undefined, {
      includeRead: true,
      ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
    })
    .filter((report) => visible(report.conversationId));
  const inbox = input.lead.inbox(0, 1000);
  const result: LeadChangeSnapshot[] = [
    {
      source: "worker_report",
      position: reports.reduce((n, report) => Math.max(n, Date.parse(report.acceptedAt)), 0),
      ...(reports.length ? { floor: Date.parse(reports[0]!.acceptedAt) - 1 } : {}),
      records: reports.map((report) =>
        leadChangeRecord(
          report.deliveryId,
          {
            kind: "worker_report",
            conversationId: report.conversationId,
            deliveryId: report.deliveryId,
            receipt: report.reportDelivery.state,
            ...(report.kind === undefined ? {} : { reportKind: report.kind }),
            preview: report.text.slice(0, 2000),
          },
          report.reportDelivery.state === "read" ? "resolved" : "active",
          report.acceptedAt,
        ),
      ),
    },
    {
      source: "inbox",
      position: inbox.next,
      ...(inbox.items.length ? { floor: inbox.items[0]!.seq - 1 } : {}),
      records: inbox.items
        .filter((item) => visible(item.conversationId))
        .map((item) =>
          leadChangeRecord(
            String(item.seq),
            {
              kind: "inbox",
              sequence: item.seq,
              conversationId: item.conversationId,
              origin: item.origin,
              preview: item.text.slice(0, 2000),
            },
            // Held text is historical context; it never establishes that a task remains open.
            "unknown",
            item.at,
          ),
        ),
    },
  ];
  try {
    const records: LeadChangeSnapshot["records"][number][] = [];
    for (const result of input.conversations.pendingLeadQuestions()) {
      const question = result.question;
      if (!question || !visible(question.conversationId)) continue;
      if (input.visibleQuestion && !(await input.visibleQuestion(question))) continue;
      records.push(
        leadChangeRecord(
          question.requestId,
          {
            kind: "owner_ask",
            conversationId: question.conversationId,
            requestId: question.requestId,
            status: "pending",
            preview: "Owner decision pending",
          },
          "active",
          question.createdAt,
        ),
      );
    }
    result.push({ source: "owner_ask", records });
  } catch {
    result.push({ source: "owner_ask", records: [], unavailable: "ask_visibility_unavailable" });
  }
  try {
    const records: LeadChangeSnapshot["records"][number][] = [];
    let cursor = "0";
    for (;;) {
      const page = await input.notes({ cursor, limit: 100 });
      if (page.outcome !== "ready") throw new Error("notes_unavailable");
      for (const note of page.notes)
        records.push(
          leadChangeRecord(
            String(note.sequence),
            {
              kind: "board_note",
              sequence: note.sequence,
              author: note.author,
              text: note.text.slice(0, 2000),
              ...(note.to === undefined ? {} : { to: note.to }),
              ...(note.wakes === undefined ? {} : { wakes: note.wakes }),
            },
            "unknown",
            note.at,
          ),
        );
      if (records.length > 2048) throw new Error("source_limit");
      if (page.notes.length === 0) break;
      const next = String(page.notes.at(-1)!.sequence);
      if (next === cursor) throw new Error("notes_cursor_stalled");
      cursor = next;
    }
    result.push({
      source: "board_note",
      records,
      position: Number(cursor),
      ...(records.length
        ? { floor: (records[0]!.item.kind === "board_note" ? records[0]!.item.sequence : 1) - 1 }
        : {}),
    });
  } catch {
    result.push({ source: "board_note", records: [], unavailable: "notes_unavailable" });
  }
  result.push(await readDesktopLeadChanges());
  return result;
}
