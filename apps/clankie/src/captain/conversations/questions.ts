import type { ConversationQuestionResult } from "@clankie/protocol";
import {
  ProjectProposalDraftSchema,
  ProjectProposalTargetSchema,
  type ProjectProposalDraft,
  type ProjectProposalResult,
} from "@clankie/protocol/projects";
import { projectsRevision, ProjectTrackerUnavailable } from "@clankie/settings";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  answerMessage,
  authorizeQuestion,
  QuestionDraftSchema,
  QuestionStateSchema,
  sameQuestionWorkspace,
  type QuestionAuthority,
  type QuestionDraft,
  type QuestionRecord,
} from "../conversation-questions.ts";
import { ProjectCreationSchema, proposalHash, proposalResult } from "../project-onboarding.ts";
import { QuestionCommitError } from "./errors.ts";
import type { ConversationStore } from "./store.ts";
import {
  type ConversationMeta,
  type ConversationServiceRequest,
  type ConversationTurnContext,
} from "./types.ts";
export function validQuestionState(ctx: ConversationStore, meta: ConversationMeta): void {
  if (ctx["corruptQuestions"].has(meta.conversationId)) throw new Error("question_state_unavailable");
  if (meta.questions !== undefined) {
    const parsed = QuestionStateSchema.safeParse(meta.questions);
    if (
      !parsed.success ||
      parsed.data.records.some((r) => r.question.conversationId !== meta.conversationId)
    ) {
      ctx["corruptQuestions"].add(meta.conversationId);
      throw new Error("question_state_unavailable");
    }
  }
}

export function assertQuestionContext(
  ctx: ConversationStore,
  meta: ConversationMeta,
  record: QuestionRecord,
): void {
  if (
    ctx["metas"].get(meta.conversationId) !== meta ||
    meta.scope.kind !== "workspace" ||
    meta.parentConversationId ||
    meta.nativeSource ||
    !ctx["questionEligible"](meta.conversationId) ||
    meta.questions?.incarnationId !== record.question.incarnationId ||
    !sameQuestionWorkspace(meta.scope.workspaceId, record.workspace)
  )
    throw new Error("question_context_lost");
}

export async function requestQuestion(
  ctx: ConversationStore,
  conversationId: string,
  draft: QuestionDraft,
  context: ConversationTurnContext,
  projectDraft?: ProjectProposalDraft,
): Promise<ConversationQuestionResult> {
  const input = QuestionDraftSchema.parse(draft);
  await authorizeQuestion(context.ownerAuthority);
  const meta = ctx["metas"].get(conversationId);
  if (
    !meta ||
    !context.questionBinding ||
    context.signal.aborted ||
    context.questionCurrent?.() === false ||
    ctx["runControllers"].get(context.runId)?.conversationId !== conversationId ||
    (context.internal && context.origin !== "input")
  )
    throw new Error("question_turn_unavailable");
  ctx["validQuestionState"](meta);
  const record: QuestionRecord = {
    issuer: { ...context.ownerAuthority!.principal },
    workspace: { ...context.questionBinding.workspace },
    question: {
      requestId: randomUUID(),
      incarnationId: context.questionBinding.incarnationId,
      conversationId,
      workspace: context.questionBinding.workspace.path,
      purpose: "preference",
      kind: input.kind,
      prompt: input.prompt,
      options: input.options.map((o) => ({ ...o, optionId: randomUUID() })),
      allowFreeform: input.kind === "text" || input.allowFreeform,
      createdAt: new Date().toISOString(),
      originRunId: context.runId,
      status: "pending",
    },
  };
  ctx["assertQuestionContext"](meta, record);
  const existing = meta.questions!.records.find((r) => r.question.status === "pending");
  if (existing) return ctx["questionResult"](meta, existing, "ready", "already_pending");
  if (meta.questions!.records.some((r) => r.projectCreation?.status === "committing"))
    throw new Error("project_confirmation_consumed");
  if (projectDraft) {
    const onboarding = ctx["projectOnboarding"];
    if (!onboarding) throw new Error("project_onboarding_unavailable");
    const revision = meta.revision;
    const parsed = ProjectProposalDraftSchema.parse(projectDraft);
    const { prompt: _prompt, evidence, ...policy } = parsed;
    const settings = await onboarding.load();
    const command = {
      ...policy,
      workspacePath: record.workspace.path,
      expectedRevision: projectsRevision(settings.projects),
    };
    let prepared: Awaited<ReturnType<typeof onboarding.prepare>>;
    try {
      prepared = await onboarding.prepare(command);
    } catch (error) {
      return ctx["questionResult"](
        meta,
        undefined,
        "refused",
        error instanceof ProjectTrackerUnavailable
          ? "project_tracker_unavailable"
          : "project_proposal_conflict",
      );
    }
    await authorizeQuestion(context.ownerAuthority);
    ctx["assertQuestionContext"](meta, record);
    if (
      meta.revision !== revision ||
      context.signal.aborted ||
      context.questionCurrent?.() === false ||
      ctx["runControllers"].get(context.runId)?.conversationId !== conversationId ||
      meta.questions!.records.some(
        (r) => r.question.status === "pending" || r.projectCreation?.status === "committing",
      )
    )
      throw new Error("project_proposal_context_changed");
    const immutable = {
      version: 1 as const,
      proposalId: randomUUID(),
      requestId: record.question.requestId,
      incarnationId: record.question.incarnationId,
      conversationId,
      originRunId: context.runId,
      workspace: record.workspace,
      command,
      ...prepared,
      evidence,
    };
    record.projectCreation = ProjectCreationSchema.parse({
      immutable,
      artifactSha256: proposalHash(immutable),
      status: "pending",
    });
  }
  const previous = meta.questions;
  const next = {
    ...previous!,
    records: [...previous!.records.filter((r) => r.question.status !== "pending").slice(-32), record],
  };
  // Pure validation before publishing the in-memory slot: bounded-state refusal has no IO.
  if (projectDraft) QuestionStateSchema.parse(next);
  meta.questions = next;
  try {
    ctx["saveQuestionMeta"](meta);
  } catch (error) {
    // Project artifacts retain their slot after ANY uncertain writer outcome. No issuer
    // closure is installed on failure, so neither an in-process nor cold retry can CREATE.
    if (!projectDraft && !(error instanceof QuestionCommitError && error.committed))
      meta.questions = previous!;
    throw error;
  }
  ctx["questionIssuers"].set(record.question.requestId, context.ownerAuthority!);
  ctx["append"](meta, {
    type: "input_requested",
    requestId: record.question.requestId,
    prompt: input.prompt,
    inputKind: input.kind,
    options: input.options.map((o) => o.label),
  });
  return ctx["questionResult"](meta, record, "ready");
}

export async function proposeProjectCreate(
  ctx: ConversationStore,
  conversationId: string,
  draft: ProjectProposalDraft,
  context: ConversationTurnContext,
): Promise<ConversationQuestionResult> {
  const parsed = ProjectProposalDraftSchema.parse(draft);
  return ctx["requestQuestion"](
    conversationId,
    QuestionDraftSchema.parse({ kind: "text", prompt: parsed.prompt }),
    context,
    parsed,
  );
}

export async function projectProposalOperation(
  ctx: ConversationStore,
  request: Extract<ConversationServiceRequest, { op: "project_proposal_get" | "project_proposal_confirm" }>,
  authority: QuestionAuthority | undefined,
): Promise<ProjectProposalResult> {
  await authorizeQuestion(authority);
  const meta = ctx["metas"].get(request.conversationId);
  if (!meta) return { status: "refused", reason: "unknown_conversation" };
  ctx["validQuestionState"](meta);
  const record = meta.questions?.records.find((r) => r.question.requestId === request.requestId);
  const creation = record?.projectCreation;
  const sameRecord = () =>
    ctx["metas"].get(request.conversationId) === meta &&
    meta.questions?.incarnationId === request.incarnationId &&
    meta.questions.records.find((r) => r.question.requestId === request.requestId) === record &&
    record?.projectCreation === creation;
  if (!record || !creation || !sameRecord()) return { status: "refused", reason: "stale_proposal" };
  const originalPrincipal = () =>
    authority?.principal.kind === record.issuer.kind && authority.principal.id === record.issuer.id;
  if (!originalPrincipal()) throw new Error("question_owner_unavailable");
  const target =
    request.op === "project_proposal_confirm"
      ? ProjectProposalTargetSchema.parse({
          conversationId: request.conversationId,
          incarnationId: request.incarnationId,
          requestId: request.requestId,
          expectedRevision: request.expectedRevision,
          proposalId: request.proposalId,
          artifactSha256: request.artifactSha256,
          expectedProjectsRevision: request.expectedProjectsRevision,
        })
      : undefined;
  const exactTarget = () =>
    !target ||
    proposalHash(target) === proposalHash(proposalResult(creation, meta.revision).proposal!.target);
  // Consumed receipts deliberately outlive the original request/JWT closure.
  if (creation.claim || creation.status !== "pending") {
    await authorizeQuestion(authority);
    if (!sameRecord() || !originalPrincipal() || !exactTarget())
      return { status: "refused", reason: "stale_proposal" };
    return proposalResult(creation, meta.revision);
  }
  const issuer = ctx["questionIssuers"].get(record.question.requestId);
  const revision = meta.revision;
  const assertCurrent = () => {
    ctx["assertQuestionContext"](meta, record);
    if (
      !sameRecord() ||
      !originalPrincipal() ||
      record.question.status !== "pending" ||
      meta.revision !== revision ||
      ctx["questionIssuers"].get(record.question.requestId) !== issuer ||
      !exactTarget()
    )
      throw new Error("project_proposal_context_changed");
  };
  const guard = async () => {
    assertCurrent();
    await authorizeQuestion(issuer);
    assertCurrent();
    await authorizeQuestion(authority);
    assertCurrent();
  };
  try {
    await guard();
  } catch {
    return { status: "refused", reason: "owner_context_lost" };
  }
  if (!target) return proposalResult(creation, meta.revision);
  // Another caller may have claimed while this caller was awaiting authorization.
  if (creation.claim) return proposalResult(creation, meta.revision);
  if (!ctx["projectOnboarding"]) return { status: "refused", reason: "project_onboarding_unavailable" };
  creation.claim = target;
  creation.status = "committing";
  try {
    ctx["saveQuestionMeta"](meta);
  } catch {
    // A throwing rename does not prove no OS effect. Consume every ambiguous claim write;
    // a cold pending record without its live issuer also cannot restart this mutation.
    creation.status = "uncertain";
    return { ...proposalResult(creation, meta.revision), reason: "claim_persistence_unavailable" };
  }
  try {
    const result = await ctx["projectOnboarding"].apply(creation, guard);
    await guard();
    creation.status = "created";
    creation.receipt = {
      projectId: creation.immutable.command.projectId,
      projectsRevision: result.revision,
    };
    record.question.status = "cancelled";
    record.question.reason = "project_created";
    record.question.resolvedAt = new Date().toISOString();
    meta.revision += 1;
    ctx["saveQuestionMeta"](meta);
    ctx["questionIssuers"].delete(record.question.requestId);
    ctx["publishQuestionResolution"](meta, record);
    return proposalResult(creation, meta.revision);
  } catch {
    // A generic settings/receipt error may follow rename. Never replay or claim no write.
    if (
      sameRecord() &&
      ((record.question.status === "pending" && meta.revision === revision) ||
        (creation.status === "created" && record.question.reason === "project_created"))
    ) {
      creation.status = "uncertain";
      delete creation.receipt;
      try {
        ctx["saveQuestionMeta"](meta);
      } catch {
        /* durable committing is already consumed */
      }
    }
    if (!sameRecord()) return { status: "uncertain", reason: "receipt_context_lost" };
    // Do not report an unpersisted success receipt from the catch path.
    return {
      ...proposalResult(creation, meta.revision),
      status: "uncertain",
      receipt: undefined,
      reason: "confirmation_uncertain",
    };
  }
}

export function questionResult(
  ctx: ConversationStore,
  meta: ConversationMeta,
  record: QuestionRecord | undefined,
  status: ConversationQuestionResult["status"],
  reason?: string,
): ConversationQuestionResult {
  return {
    status,
    conversationId: meta.conversationId,
    revision: meta.revision,
    safeCursor: ctx["lastCursor"](meta),
    ...(meta.questions ? { incarnationId: meta.questions.incarnationId } : {}),
    ...(record ? { question: structuredClone(record.question) } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function cancelPendingQuestion(
  ctx: ConversationStore,
  conversationId: string,
  reason: string,
  originRunId?: string,
): void {
  const meta = ctx["metas"].get(conversationId);
  if (!meta) return;
  ctx["validQuestionState"](meta);
  const record = meta.questions?.records.find(
    (r) =>
      r.question.status === "pending" &&
      (originRunId === undefined || r.question.originRunId === originRunId),
  );
  if (!record) return;
  const before = structuredClone(meta);
  record.question.status = "cancelled";
  record.question.reason = reason;
  record.question.resolvedAt = new Date().toISOString();
  meta.revision += 1;
  try {
    ctx["saveQuestionMeta"](meta);
  } catch (error) {
    if (!(error instanceof QuestionCommitError && error.committed)) Object.assign(meta, before);
    throw error;
  }
  ctx["questionIssuers"].delete(record.question.requestId);
  ctx["publishQuestionResolution"](meta, record);
}

export function invalidateQuestionPrincipal(ctx: ConversationStore, deviceId: string): void {
  for (const meta of ctx["metas"].values()) {
    if (
      meta.questions?.records.some(
        (r) => r.question.status === "pending" && r.issuer.kind === "device" && r.issuer.id === deviceId,
      )
    )
      ctx["cancelPendingQuestion"](meta.conversationId, "owner_context_lost");
  }
}

export function publishQuestionResolution(
  ctx: ConversationStore,
  meta: ConversationMeta,
  record: QuestionRecord,
): void {
  ctx["append"](meta, {
    type: "input_resolved",
    requestId: record.question.requestId,
    outcome: record.question.status === "submitted" ? "submitted" : "cancelled",
  });
}

export async function questionOperation(
  ctx: ConversationStore,
  request: Extract<ConversationServiceRequest, { op: "input_get" | "input_answer" | "input_cancel" }>,
  authority: QuestionAuthority | undefined,
): Promise<ConversationQuestionResult> {
  await authorizeQuestion(authority);
  let meta = ctx["metas"].get(request.conversationId);
  if (!meta)
    return { status: "refused", conversationId: request.conversationId, reason: "unknown_conversation" };
  ctx["validQuestionState"](meta);
  let record = meta.questions?.records.find((r) =>
    request.requestId ? r.question.requestId === request.requestId : r.question.status === "pending",
  );
  if (record?.question.status === "pending") {
    const checkedRequestId = record.question.requestId;
    const issuer = ctx["questionIssuers"].get(checkedRequestId);
    let lost = false;
    try {
      ctx["assertQuestionContext"](meta, record);
      if (issuer) await authorizeQuestion(issuer);
      else lost = true;
    } catch {
      lost = true;
    }
    await authorizeQuestion(authority);
    meta = ctx["metas"].get(request.conversationId);
    if (!meta)
      return { status: "refused", conversationId: request.conversationId, reason: "unknown_conversation" };
    ctx["validQuestionState"](meta);
    record = meta.questions?.records.find((r) =>
      request.requestId ? r.question.requestId === request.requestId : r.question.status === "pending",
    );
    if (record && record.question.requestId !== checkedRequestId)
      return ctx["questionResult"](meta, undefined, "refused", "context_changed");
    if (lost && record?.question.status === "pending")
      ctx["cancelPendingQuestion"](meta.conversationId, "owner_context_lost");
  }
  if (request.op === "input_get")
    return ctx["questionResult"](meta, record, "ready", record ? undefined : "unknown_request");
  if (!record || request.incarnationId !== meta.questions?.incarnationId)
    return ctx["questionResult"](meta, undefined, "refused", "stale_request");
  if (record.projectCreation?.claim)
    return ctx["questionResult"](meta, record, "refused", "project_confirmation_consumed");
  // Authenticated duplicate reconciliation precedes revision checks, never enqueue.
  if (record.question.status !== "pending") {
    if (
      request.op === "input_answer" &&
      record.question.status === "submitted" &&
      JSON.stringify(request.answer) !== JSON.stringify(record.question.answer)
    )
      return ctx["questionResult"](meta, record, "refused", "conflicting_answer");
    return ctx["questionResult"](meta, record, "resolved");
  }
  try {
    ctx["assertQuestionContext"](meta, record);
  } catch {
    ctx["cancelPendingQuestion"](meta.conversationId, "owner_context_lost");
    return ctx["questionResult"](meta, record, "refused", "owner_context_lost");
  }
  if (request.expectedRevision !== meta.revision)
    return ctx["questionResult"](meta, record, "revision_conflict");
  if (request.op === "input_cancel") {
    ctx["cancelPendingQuestion"](meta.conversationId, "owner_cancelled");
    return ctx["questionResult"](meta, record, "resolved");
  }
  const answer = request.answer;
  if (
    (answer.kind === "choice" && !record.question.options.some((o) => o.optionId === answer.optionId)) ||
    (answer.kind === "text" && !record.question.allowFreeform)
  )
    return ctx["questionResult"](meta, record, "refused", "invalid_answer");
  const message = answerMessage(record.question, answer);
  try {
    ctx["enqueue"](meta, message, undefined, false, ctx["runner"], {
      origin: "input",
      delivery: "queue",
      ownerAuthority: authority!,
      questionBinding: { incarnationId: request.incarnationId, workspace: record.workspace },
      inputAnswer: { requestId: request.requestId, answer },
      questionAnswer: { record, answer, authority: authority! },
    });
  } catch (error) {
    // Read the durable boundary. An uncertain post-rename answer is consumed, never resubmitted.
    const stored = JSON.parse(
      readFileSync(join(ctx["root"], meta.conversationId, "meta.json"), "utf8"),
    ) as ConversationMeta;
    const checked = QuestionStateSchema.parse(stored.questions);
    const receipt = checked.records.find((r) => r.question.requestId === request.requestId);
    if (!receipt || receipt.question.status !== "submitted") throw error;
    meta.questions = checked;
    record = receipt;
    meta.sessionState = (ctx["runCounts"].get(meta.conversationId) ?? 0) > 0 ? "active" : "failed";
    if (record.question.continuation) {
      record.question.continuation.state = "failed";
      record.question.continuation.reasonCode = "acceptance_interrupted";
    }
    ctx["saveQuestionMeta"](meta);
    ctx["wakeTails"](meta.conversationId);
    return ctx["questionResult"](meta, record, "resolved", "acceptance_interrupted");
  }
  ctx["questionIssuers"].delete(request.requestId);
  return ctx["questionResult"](meta, record, "resolved");
}

export function saveQuestionMeta(ctx: ConversationStore, meta: ConversationMeta): void {
  if (meta.questions) QuestionStateSchema.parse(meta.questions);
  const path = join(ctx["root"], meta.conversationId, "meta.json");
  const temporary = `${path}.${randomUUID()}.tmp`;
  let committed = false;
  try {
    const file = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(file, JSON.stringify(meta, null, 2));
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
    committed = true;
    const directory = openSync(join(ctx["root"], meta.conversationId), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error) {
    throw new QuestionCommitError(committed, error);
  } finally {
    rmSync(temporary, { force: true });
  }
}
