import { z } from "zod";
import {
  authorizeQuestion,
  QuestionStateSchema,
  type QuestionAuthority,
  type QuestionRecord,
} from "../conversation-questions.ts";
import { assertQuestionContext } from "./questions.ts";
import type { ConversationStore } from "./store.ts";
import type { ConversationMeta } from "./types.ts";

/**
 * Host-only read fence over live tracker-linked owner questions, for the work inbox.
 * It names pending questions and proves they are still the same live records; it is
 * not authority to answer, cancel or approve them, and nothing here mutates the store.
 */
const INBOX_QUESTION_BATCH_LIMIT = 250;

interface InboxQuestionTarget {
  readonly conversationId: string;
  readonly incarnationId: string;
  readonly requestId: string;
}
interface InboxQuestionProjection {
  readonly target: InboxQuestionTarget;
  readonly expectedRevision: number;
  readonly purpose: "decision" | "verify" | "gate";
  readonly createdAt: string;
  readonly deadlineAt?: string;
}
export interface InboxQuestionReadFence {
  readonly rows: readonly InboxQuestionProjection[];
  /** Reruns the owner's authorization, then every live-state check. Repairs nothing. */
  recheck(): Promise<void>;
  /** Synchronous; call after each await and immediately before dispatch or return. */
  assertCurrent(): void;
}

const RequestIdsSchema = z.array(z.string().uuid()).min(1).max(INBOX_QUESTION_BATCH_LIMIT);
const INBOX_PURPOSES: ReadonlySet<string> = new Set(["decision", "verify", "gate"]);

interface Captured {
  readonly meta: ConversationMeta;
  readonly record: QuestionRecord;
  readonly revision: number;
  readonly projection: InboxQuestionProjection;
}

/** Same schema check as `validQuestionState`, without remembering corruption. */
function assertQuestionStateReadable(ctx: ConversationStore, meta: ConversationMeta): void {
  if (ctx["corruptQuestions"].has(meta.conversationId)) throw new Error("question_state_unavailable");
  if (meta.questions === undefined) return;
  const parsed = QuestionStateSchema.safeParse(meta.questions);
  if (!parsed.success || parsed.data.records.some((r) => r.question.conversationId !== meta.conversationId))
    throw new Error("question_state_unavailable");
}

/** A due decision deadline makes the question ineligible; it is never expired from here. */
function eligible(record: QuestionRecord): boolean {
  const { question } = record;
  if (!INBOX_PURPOSES.has(question.purpose) || question.workerQuestion || record.projectCreation)
    return false;
  if (question.status !== "pending") return false;
  if (
    record.persistenceUncertain ||
    record.workerDelivery ||
    record.responder ||
    record.message !== undefined
  )
    return false;
  const deadline = record.decisionPolicy?.deadlineAt;
  return deadline === undefined || Date.parse(deadline) > Date.now();
}

function capture(ctx: ConversationStore, requestIds: readonly string[]): Captured[] {
  const wanted = new Set(requestIds);
  const seen = new Set<string>();
  const captured: Captured[] = [];
  for (const meta of ctx["metas"].values()) {
    if (!meta.questions?.records.some((record) => wanted.has(record.question.requestId))) continue;
    assertQuestionStateReadable(ctx, meta);
    for (const record of meta.questions.records) {
      const { question } = record;
      if (!wanted.has(question.requestId)) continue;
      // Two canonical matches are corruption, never "first wins".
      if (seen.has(question.requestId)) throw new Error("inbox_question_ambiguous");
      seen.add(question.requestId);
      assertQuestionContext(ctx, meta, record);
      if (!eligible(record)) continue;
      const deadlineAt = record.decisionPolicy?.deadlineAt;
      captured.push({
        meta,
        record,
        revision: meta.revision,
        projection: Object.freeze({
          target: Object.freeze({
            conversationId: meta.conversationId,
            incarnationId: question.incarnationId,
            requestId: question.requestId,
          }),
          expectedRevision: meta.revision,
          purpose: question.purpose as InboxQuestionProjection["purpose"],
          createdAt: question.createdAt,
          ...(deadlineAt === undefined ? {} : { deadlineAt }),
        }),
      });
    }
  }
  return captured;
}

export async function prepareInboxQuestions(
  ctx: ConversationStore,
  requestIds: readonly string[],
  authority: QuestionAuthority,
): Promise<InboxQuestionReadFence> {
  const ids = RequestIdsSchema.safeParse(requestIds);
  if (!ids.success || new Set(ids.data).size !== ids.data.length)
    throw new Error("inbox_request_ids_invalid");
  await authorizeQuestion(authority);
  const principal = { kind: authority.principal.kind, id: authority.principal.id };
  const captured = capture(ctx, ids.data);
  const assertCurrent = (): void => {
    if (
      !authority.current() ||
      authority.principal.kind !== principal.kind ||
      authority.principal.id !== principal.id
    )
      throw new Error("question_owner_unavailable");
    // Ineligible/absent records are part of completeness too. A newly pending or replaced
    // record must invalidate this projection, even if the original page was empty.
    const current = capture(ctx, ids.data);
    if (
      current.length !== captured.length ||
      current.some(
        (entry, index) =>
          entry.meta !== captured[index]!.meta ||
          entry.record !== captured[index]!.record ||
          entry.revision !== captured[index]!.revision,
      )
    )
      throw new Error("inbox_fence_stale");
    for (const { meta, record, revision } of captured) {
      if (
        ctx["metas"].get(meta.conversationId) !== meta ||
        !meta.questions?.records.includes(record) ||
        meta.revision !== revision ||
        !eligible(record)
      )
        throw new Error("inbox_fence_stale");
      assertQuestionContext(ctx, meta, record);
    }
  };
  assertCurrent();
  return {
    rows: Object.freeze(captured.map(({ projection }) => projection)),
    async recheck() {
      await authorizeQuestion(authority);
      assertCurrent();
    },
    assertCurrent,
  };
}
