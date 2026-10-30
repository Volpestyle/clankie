import { createHash } from "node:crypto";
import {
  FeedItemSchema,
  type ConversationQuestion,
  type ConversationQuestionResult,
  type FeedCheckItem,
  type FeedCheckRequest,
  type FeedCheckResult,
  type OperatorConversationServiceRequest,
  type OperatorConversationServiceResult,
} from "@clankie/protocol";
import type { ClankieSettings } from "@clankie/settings";
import type { QuestionDraft } from "./captain/conversation-questions.ts";
import { leadCapable, projectLeadConversation } from "./feed-drops.ts";
import { evidenceHash, evidenceMedia, withEvidenceTypes, type EvidenceTypes } from "./feed-media.ts";

type Serve = (request: OperatorConversationServiceRequest) => Promise<OperatorConversationServiceResult>;

export interface FeedChecksOptions {
  readonly settings?: { load(): Promise<ClankieSettings> };
  readonly evidence?: EvidenceTypes;
  /** Raises a host ask in an existing chat (ADR 0245); `publicationId` makes a retry find it. */
  readonly requestOwnerAsk: (
    conversationId: string,
    draft: QuestionDraft,
    publicationId: string,
  ) => Promise<ConversationQuestionResult>;
}

export const CHECK_WORKS = "It works";
export const CHECK_SEND_BACK = "Send it back";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Quick checks (step 5, C4): an agent asks the owner to look at one thing, as a
 * pending verify ask in the chat that should hear the answer. The check line is
 * the agent's own words: shown to the owner, never run, and it grants nothing.
 */
export function createFeedChecks(options: FeedChecksOptions) {
  async function raise(request: FeedCheckRequest, serve: Serve): Promise<FeedCheckResult> {
    const settings = await options.settings?.load();
    const project =
      request.projectId === undefined
        ? undefined
        : settings?.projects.projects.find((entry) => entry.id === request.projectId);
    if (request.projectId !== undefined && project === undefined)
      return {
        outcome: "refused",
        reason: "unknown_project",
        message: `There is no project ${request.projectId} on this Clankie. clankie project list names them.`,
      };
    const listed = await serve({ op: "list", schemaVersion: 1 });
    if (listed.op !== "list") throw new Error("Unexpected conversation list");
    const named = listed.conversations.find((entry) => entry.conversationId === request.conversationId);
    if (request.conversationId !== undefined && !leadCapable(named))
      return {
        outcome: "refused",
        reason: "unknown_conversation",
        message: `Conversation ${request.conversationId} can't take a check's answer: name a top-level chat, or a project.`,
      };
    const main = listed.conversations.find(
      (conversation) => conversation.scope.kind === "global" && conversation.isDefault,
    );
    const conversationId =
      request.conversationId ??
      (request.projectId !== undefined && settings !== undefined
        ? projectLeadConversation(settings, request.projectId, listed.conversations)
        : undefined) ??
      main?.conversationId;
    if (conversationId === undefined)
      return {
        outcome: "unavailable",
        message: "This Clankie has no chat to take the answer. Start Clankie's main chat, then ask again.",
      };

    const sha = request.evidence === undefined ? undefined : evidenceHash(request.evidence);
    if (sha !== undefined && (await options.evidence?.recordForBlob(sha)) === undefined)
      return {
        outcome: "refused",
        reason: "evidence_missing",
        message:
          "The evidence store holds no record for that link. Store it first (clankie evidence), then ask with its link.",
      };

    const draft: QuestionDraft = {
      kind: "choice",
      purpose: "verify",
      prompt: request.check,
      check: request.check,
      ...(request.longer ? { longer: true } : {}),
      ...(request.evidence ? { evidence: request.evidence } : {}),
      ...(request.issue ? { issue: request.issue } : {}),
      ...(request.projectId ? { projectId: request.projectId } : {}),
      waitingOn: request.waitingOn ?? "The owner's check",
      options: [
        { label: CHECK_WORKS, description: "It looks right." },
        { label: CHECK_SEND_BACK, description: "Say what is wrong." },
      ],
      allowFreeform: true,
    };
    // The key is the caller's; the source chat sees a hash of it, never the key.
    const publicationId = `feed-check:${sha256(`feed-check:${request.idempotencyKey}`).slice(0, 48)}`;
    const earlier = await findPublished(serve, publicationId);
    if (earlier !== undefined && !sameCheck(earlier.question, conversationId, draft))
      return {
        outcome: "refused",
        reason: "idempotency_conflict",
        message: "That key already asked a different check. Use a new key for a new check.",
      };

    const result = await options.requestOwnerAsk(conversationId, draft, publicationId);
    const question = result.question;
    if (question === undefined || result.revision === undefined)
      return {
        outcome: "unavailable",
        message: `The check couldn't be asked right now${result.reason ? ` (${result.reason})` : ""}. Ask again with the same key.`,
      };
    const item = FeedItemSchema.parse({
      kind: "check",
      id: `check:${question.requestId}`,
      at: new Date(Date.parse(question.createdAt)).toISOString(),
      ...(request.projectId ? { projectId: request.projectId } : {}),
      check: {
        question,
        revision: result.revision,
        line: request.check,
        ...(question.longer ? { longer: true } : {}),
        ...(sha === undefined ? {} : { media: [evidenceMedia(sha)] }),
      },
    });
    const [typed] = await withEvidenceTypes([item as FeedCheckItem], options.evidence);
    return {
      outcome: "raised",
      item: typed as FeedCheckItem,
      duplicate:
        earlier !== undefined || result.reason === "already_pending" || result.reason === "already_resolved",
    };
  }

  return { raise };
}

/** An ask this key already published, in any state, so a retry never asks twice. */
async function findPublished(serve: Serve, publicationId: string) {
  for (const status of ["pending", "submitted", "cancelled"] as const) {
    const listed = await serve({ op: "input_list", schemaVersion: 1, status });
    if (listed.op !== "input_list") throw new Error("Unexpected question list");
    const found = listed.result.questions.find((entry) => entry.question?.originRunId === publicationId);
    if (found?.question) return { question: found.question };
  }
  return undefined;
}

function sameCheck(question: ConversationQuestion, conversationId: string, draft: QuestionDraft): boolean {
  return (
    question.conversationId === conversationId &&
    question.check === draft.check &&
    (question.longer === true) === (draft.longer === true) &&
    question.evidence === draft.evidence &&
    question.projectId === draft.projectId &&
    JSON.stringify(question.issue ?? null) === JSON.stringify(draft.issue ?? null) &&
    question.waitingOn === draft.waitingOn
  );
}
