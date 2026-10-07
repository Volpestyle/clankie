import type { ConversationQuestionResult } from "@clankie/protocol";
import {
  ProjectProposalDraftSchema,
  ProjectProposalTargetSchema,
  type ProjectProposalDraft,
  type ProjectProposalResult,
} from "@clankie/protocol/projects";
import { projectsRevision, ProjectTrackerUnavailable } from "@clankie/settings";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
  const workspaceBound = record.projectCreation || record.question.purpose === "preference";
  if (
    ctx["metas"].get(meta.conversationId) !== meta ||
    meta.questions?.incarnationId !== record.question.incarnationId ||
    (workspaceBound &&
      (meta.scope.kind !== "workspace" ||
        meta.parentConversationId ||
        meta.nativeSource ||
        !ctx["questionEligible"](meta.conversationId) ||
        !record.workspace ||
        !sameQuestionWorkspace(
          meta.scope.kind === "workspace" ? meta.scope.workspaceId : "",
          record.workspace,
        )))
  )
    throw new Error("question_context_lost");
}

export async function requestQuestion(
  ctx: ConversationStore,
  conversationId: string,
  draft: QuestionDraft,
  context: ConversationTurnContext,
  projectDraft?: ProjectProposalDraft,
  surface = false,
): Promise<ConversationQuestionResult> {
  const input = QuestionDraftSchema.parse(draft);
  const workspaceBound = !!projectDraft || input.purpose === "preference";
  if (workspaceBound) await authorizeQuestion(context.ownerAuthority);
  const meta = ctx["metas"].get(conversationId);
  if (
    !meta ||
    (workspaceBound && !context.questionBinding?.workspace) ||
    context.signal.aborted ||
    context.questionCurrent?.() === false ||
    (!surface && ctx["runControllers"].get(context.runId)?.conversationId !== conversationId) ||
    (workspaceBound && context.internal && context.origin !== "input")
  )
    throw new Error("question_turn_unavailable");
  ctx["validQuestionState"](meta);
  const matchingPending = () =>
    meta.questions?.records.find((record) => {
      if (record.question.status !== "pending") return false;
      if (workspaceBound) return !!record.projectCreation || record.question.purpose === "preference";
      if (record.projectCreation || record.question.workerQuestion || input.workerQuestion) return false;
      if (!isDeepStrictEqual(record.workspace, context.questionBinding?.workspace)) return false;
      const q = record.question;
      return isDeepStrictEqual(
        {
          purpose: q.purpose,
          kind: q.kind,
          prompt: q.prompt,
          options: q.options.map(({ optionId: _id, ...option }) => option),
          allowFreeform: q.allowFreeform,
          ...(q.recommendation ? { recommendation: q.recommendation } : {}),
          ...(q.waitingOn ? { waitingOn: q.waitingOn } : {}),
          ...(q.steps ? { steps: q.steps } : {}),
          ...(q.gate ? { gate: q.gate } : {}),
        },
        { ...input, allowFreeform: input.kind === "text" || input.allowFreeform },
      );
    });
  const pending = matchingPending();
  if (pending) return ctx["questionResult"](meta, pending, "ready", "already_pending");
  if (input.purpose === "approval" && !(await ctx["questionGate"]?.(conversationId, input.gate!)))
    return ctx["questionResult"](meta, undefined, "refused", "approval_not_owner_reserved");
  const workerQuestion = input.workerQuestion
    ? await ctx["prepareWorkerQuestion"]?.(
        input.workerQuestion.seatId,
        input.workerQuestion.requestId,
        conversationId,
      )
    : undefined;
  if (input.workerQuestion && !workerQuestion) throw new Error("worker_question_unavailable");
  if (workerQuestion) {
    for (const source of ctx["metas"].values()) {
      ctx["validQuestionState"](source);
      const existingWorker = source.questions?.records.find((record) => {
        const worker = record.question.workerQuestion;
        return (
          worker &&
          worker.seatId === workerQuestion.seatId &&
          worker.sessionId === workerQuestion.sessionId &&
          worker.requestId === workerQuestion.requestId &&
          (record.question.status === "pending" || record.workerDelivery)
        );
      });
      if (existingWorker)
        return ctx["questionResult"](
          source,
          existingWorker,
          existingWorker.question.status === "pending" ? "ready" : "resolved",
          existingWorker.question.status === "pending" ? "already_pending" : "worker_answer_consumed",
        );
    }
  }
  if (
    context.signal.aborted ||
    context.questionCurrent?.() === false ||
    ctx["metas"].get(conversationId) !== meta
  )
    throw new Error("question_turn_unavailable");
  const concurrent = matchingPending();
  if (concurrent) return ctx["questionResult"](meta, concurrent, "ready", "already_pending");
  meta.questions ??= { incarnationId: randomUUID(), records: [] };
  const record: QuestionRecord = {
    ...(context.ownerAuthority ? { issuer: { ...context.ownerAuthority.principal } } : {}),
    ...(context.questionBinding?.workspace ? { workspace: { ...context.questionBinding.workspace } } : {}),
    question: {
      requestId: randomUUID(),
      incarnationId: meta.questions.incarnationId,
      conversationId,
      ...(context.questionBinding?.workspace ? { workspace: context.questionBinding.workspace!.path } : {}),
      purpose: input.purpose,
      ...(input.recommendation ? { recommendation: input.recommendation } : {}),
      ...(input.waitingOn ? { waitingOn: input.waitingOn } : {}),
      ...(input.steps ? { steps: input.steps } : {}),
      ...(input.gate ? { gate: input.gate } : {}),
      ...(workerQuestion ? { workerQuestion } : {}),
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
  const existing = matchingPending();
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
      workspacePath: record.workspace!.path,
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
        (r) =>
          (r.question.status === "pending" && (r.projectCreation || r.question.purpose === "preference")) ||
          r.projectCreation?.status === "committing",
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
  // Native delivery uncertainty must outlive the ordinary recent-answer window.
  // Refuse bounded-state overflow rather than forgetting a claim and allowing replay.
  const settled = previous!.records.filter((r) => r.question.status !== "pending");
  const protectedClaims = settled.filter((r) => r.workerDelivery && r.workerDelivery.state !== "delivered");
  const recentLimit = Math.max(0, 32 - protectedClaims.length);
  const recent = recentLimit ? settled.filter((r) => !protectedClaims.includes(r)).slice(-recentLimit) : [];
  const next = {
    ...previous!,
    records: [
      ...previous!.records.filter(
        (r) => r.question.status === "pending" || protectedClaims.includes(r) || recent.includes(r),
      ),
      record,
    ],
  };
  // Pure validation before publishing the in-memory slot: bounded-state refusal has no IO.
  QuestionStateSchema.parse(next);
  meta.questions = next;
  try {
    ctx["saveQuestionMeta"](meta);
  } catch (error) {
    // Project artifacts retain their slot after ANY uncertain writer outcome. No issuer
    // closure is installed on failure, so neither an in-process nor cold retry can CREATE.
    if (workspaceBound && !projectDraft && !(error instanceof QuestionCommitError && error.committed))
      meta.questions = previous!;
    else record.persistenceUncertain = true;
    throw error;
  }
  if (context.ownerAuthority) ctx["questionIssuers"].set(record.question.requestId, context.ownerAuthority);
  ctx["append"](meta, {
    type: "input_requested",
    requestId: record.question.requestId,
    prompt: input.prompt,
    inputKind: input.kind,
    ...(input.purpose !== "preference" ? { purpose: input.purpose } : {}),
    ...(input.waitingOn ? { waitingOn: input.waitingOn } : {}),
    ...(input.recommendation ? { recommendation: input.recommendation } : {}),
    ...(input.steps ? { steps: input.steps } : {}),
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

export async function proposeProjectDefaults(
  ctx: ConversationStore,
  conversationId: string,
  context: ConversationTurnContext,
): Promise<ConversationQuestionResult | ProjectProposalResult> {
  await authorizeQuestion(context.ownerAuthority);
  const meta = ctx["metas"].get(conversationId);
  if (!meta || !context.questionBinding || !ctx["projectOnboarding"])
    throw new Error("project_onboarding_unavailable");
  ctx["validQuestionState"](meta);
  const existing = meta.questions?.records.find(
    (r) => r.question.status === "pending" && (r.projectCreation || r.question.purpose === "preference"),
  );
  if (existing)
    return existing.projectCreation
      ? ctx["projectProposalOperation"](
          {
            op: "project_proposal_get",
            schemaVersion: 1,
            conversationId,
            requestId: existing.question.requestId,
            incarnationId: existing.question.incarnationId,
          },
          context.ownerAuthority,
        )
      : ctx["questionResult"](meta, existing, "ready", "already_pending");
  const inferred = await ctx["projectOnboarding"].defaults(context.questionBinding.workspace!.path);
  // requestQuestion repeats owner, workspace, current-turn and pending-slot checks after the IO.
  const result = inferred.draft
    ? await ctx["proposeProjectCreate"](conversationId, inferred.draft, context)
    : await ctx["requestQuestion"](
        conversationId,
        QuestionDraftSchema.parse({ kind: "text", prompt: inferred.question }),
        context,
      );
  if (!inferred.draft || !result.question || result.status !== "ready") return result;
  return ctx["projectProposalOperation"](
    {
      op: "project_proposal_get",
      schemaVersion: 1,
      conversationId,
      requestId: result.question.requestId,
      incarnationId: result.question.incarnationId,
    },
    context.ownerAuthority,
  );
}

export async function projectProposalOperation(
  ctx: ConversationStore,
  request: Extract<
    ConversationServiceRequest,
    { op: "project_proposal_get" | "project_proposal_confirm" | "project_proposal_tweak" }
  >,
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
    authority?.principal.kind === record.issuer?.kind && authority?.principal.id === record.issuer?.id;
  if (!originalPrincipal()) throw new Error("question_owner_unavailable");
  const target =
    request.op !== "project_proposal_get"
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
  if (request.op === "project_proposal_tweak") {
    const change = request.change;
    const command = {
      ...creation.immutable.command,
      ...(change.field === "tracker" ? change.value : { [change.field]: change.value }),
    };
    // Tracker replacement clears both leaves before applying the reviewed field.
    if (change.field === "tracker") {
      command.trackerRef = change.value.trackerRef;
      command.trackerSetup = change.value.trackerSetup;
    }
    let prepared: Awaited<ReturnType<NonNullable<ConversationStore["projectOnboarding"]>["prepare"]>>;
    try {
      prepared = await ctx["projectOnboarding"].prepare(command);
    } catch {
      return { status: "refused", reason: "project_proposal_conflict" };
    }
    try {
      await guard();
    } catch {
      return { status: "refused", reason: "owner_context_lost" };
    }
    if (creation.claim) return proposalResult(creation, meta.revision);
    const previousRoles = creation.immutable.effectiveRoles.map((r) => `${r.role}:`);
    const immutable = {
      ...creation.immutable,
      command,
      ...prepared,
      proposalId: randomUUID(),
      evidence: [
        ...creation.immutable.evidence.filter(
          (line) =>
            !line.startsWith(`${change.field}:`) &&
            !(change.field === "roles" && previousRoles.some((role) => line.startsWith(role))),
        ),
        ...(change.field === "roles"
          ? prepared.effectiveRoles.map((r) => `${r.role}: Requested by the owner.`)
          : [`${change.field}: Owner reviewed this field.`]),
      ].slice(-8),
    };
    const replacement = ProjectCreationSchema.parse({
      immutable,
      artifactSha256: proposalHash(immutable),
      status: "pending",
    });
    record.projectCreation = replacement;
    meta.revision += 1;
    try {
      ctx["saveQuestionMeta"](meta);
    } catch {
      // The rename may have happened. Keep the new slot, disable confirmation,
      // and never restore an old target or replay a possibly committed tweak.
      ctx["questionIssuers"].delete(record.question.requestId);
      return { status: "uncertain", reason: "tweak_persistence_unavailable" };
    }
    return proposalResult(replacement, meta.revision);
  }
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
  requestId?: string,
): void {
  const meta = ctx["metas"].get(conversationId);
  if (!meta) return;
  ctx["validQuestionState"](meta);
  const records =
    meta.questions?.records.filter(
      (r) =>
        r.question.status === "pending" &&
        (originRunId === undefined || r.question.originRunId === originRunId) &&
        (requestId === undefined || r.question.requestId === requestId),
    ) ?? [];
  if (!records.length) return;
  const before = structuredClone(meta);
  for (const record of records) {
    record.question.status = "cancelled";
    record.question.reason = reason;
    record.question.resolvedAt = new Date().toISOString();
  }
  meta.revision += 1;
  try {
    ctx["saveQuestionMeta"](meta);
  } catch (error) {
    if (!(error instanceof QuestionCommitError && error.committed)) Object.assign(meta, before);
    throw error;
  }
  for (const record of records) {
    ctx["questionIssuers"].delete(record.question.requestId);
    ctx["publishQuestionResolution"](meta, record);
  }
}

export function invalidateQuestionPrincipal(ctx: ConversationStore, deviceId: string): void {
  for (const meta of ctx["metas"].values()) {
    const owned =
      meta.questions?.records.filter(
        (r) => r.question.status === "pending" && r.issuer?.kind === "device" && r.issuer.id === deviceId,
      ) ?? [];
    for (const record of owned)
      ctx["cancelPendingQuestion"](
        meta.conversationId,
        "owner_context_lost",
        undefined,
        record.question.requestId,
      );
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
  if (
    record?.question.status === "pending" &&
    record.question.workerQuestion &&
    !record.workerDelivery &&
    !ctx["workerAnswerInFlight"].has(record.question.requestId) &&
    ctx["reconcileWorkerQuestion"] &&
    (await ctx["reconcileWorkerQuestion"](record.question)) === "resolved"
  ) {
    await authorizeQuestion(authority);
    if (
      ctx["metas"].get(meta.conversationId) === meta &&
      meta.questions?.records.includes(record) &&
      record.question.status === "pending" &&
      !record.workerDelivery &&
      !ctx["workerAnswerInFlight"].has(record.question.requestId)
    )
      ctx["resolveWorkerQuestionElsewhere"](meta, record, authority!);
  }
  if (record?.question.status === "pending") {
    const checkedRequestId = record.question.requestId;
    const issuer = ctx["questionIssuers"].get(checkedRequestId);
    const workspaceBound = record.projectCreation || record.question.purpose === "preference";
    let lost = false;
    try {
      ctx["assertQuestionContext"](meta, record);
      if (workspaceBound) {
        if (issuer) await authorizeQuestion(issuer);
        else lost = true;
      }
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
      ctx["cancelPendingQuestion"](
        meta.conversationId,
        "owner_context_lost",
        undefined,
        record.question.requestId,
      );
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
      !isDeepStrictEqual(request.answer, record.question.answer)
    )
      return ctx["questionResult"](meta, record, "refused", "conflicting_answer");
    return ctx["questionResult"](meta, record, "resolved");
  }
  try {
    ctx["assertQuestionContext"](meta, record);
  } catch {
    ctx["cancelPendingQuestion"](
      meta.conversationId,
      "owner_context_lost",
      undefined,
      record.question.requestId,
    );
    return ctx["questionResult"](meta, record, "refused", "owner_context_lost");
  }
  if (request.expectedRevision !== meta.revision)
    return ctx["questionResult"](meta, record, "revision_conflict");
  if (request.op === "input_cancel") {
    ctx["cancelPendingQuestion"](
      meta.conversationId,
      "owner_cancelled",
      undefined,
      record.question.requestId,
    );
    return ctx["questionResult"](meta, record, "resolved");
  }
  const answer = request.answer;
  if (
    (answer.kind === "choice" && !record.question.options.some((o) => o.optionId === answer.optionId)) ||
    (answer.kind === "text" && !record.question.allowFreeform)
  )
    return ctx["questionResult"](meta, record, "refused", "invalid_answer");
  if (record.persistenceUncertain)
    return ctx["questionResult"](meta, record, "refused", "ask_persistence_uncertain");
  if (ctx["workerAnswerInFlight"].has(record.question.requestId))
    return ctx["questionResult"](meta, record, "ready", "answer_in_progress");
  if (record.workerDelivery && !isDeepStrictEqual(record.workerDelivery.answer, answer))
    return ctx["questionResult"](meta, record, "refused", "conflicting_answer");
  if (record.question.workerQuestion) {
    if (answer.kind !== "worker" || !ctx["deliverWorkerAnswer"])
      return ctx["questionResult"](meta, record, "refused", "invalid_worker_answer");
    const ids = record.question.workerQuestion.questions.map((q) => q.id);
    if (Object.keys(answer.answers).length !== ids.length || ids.some((id) => !answer.answers[id]))
      return ctx["questionResult"](meta, record, "refused", "invalid_worker_answer");
    if (!record.workerDelivery) {
      record.workerDelivery = { state: "attempting", answer };
      ctx["workerAnswerInFlight"].add(record.question.requestId);
      // Persist the native delivery claim before touching the worker. An ambiguous
      // transport or write can never cause a second native answer.
      try {
        ctx["saveQuestionMeta"](meta);
      } catch {
        record.workerDelivery.state = "uncertain";
        ctx["workerAnswerInFlight"].delete(record.question.requestId);
        throw new Error("worker_answer_uncertain");
      }
      try {
        await authorizeQuestion(authority);
        await ctx["deliverWorkerAnswer"](record.question, answer, authority!);
        record.workerDelivery.state = "delivered";
      } catch (error) {
        record.workerDelivery.state = "uncertain";
        record.workerDelivery.detail = (error instanceof Error ? error.message : String(error)).slice(
          0,
          2000,
        );
      }
      ctx["workerAnswerInFlight"].delete(record.question.requestId);
      ctx["saveQuestionMeta"](meta);
    } else if (record.workerDelivery.state === "attempting") {
      record.workerDelivery.state = "uncertain";
      record.workerDelivery.detail = "worker_answer_interrupted";
    }
  } else if (answer.kind === "worker")
    return ctx["questionResult"](meta, record, "refused", "invalid_answer");
  if (record.workerDelivery?.state === "uncertain") record.question.reason = "worker_answer_uncertain";
  const message =
    answerMessage(record.question, answer) +
    (record.workerDelivery
      ? `\nWorker question answer delivery outcome: ${record.workerDelivery.state}; detail: ${JSON.stringify(record.workerDelivery.detail)}. Never replay uncertain native delivery.`
      : "");
  try {
    ctx["enqueue"](meta, message, undefined, true, ctx["runner"], {
      origin: "input",
      delivery: "queue",
      ownerAuthority: authority!,
      questionBinding: {
        incarnationId: request.incarnationId,
        ...(record.workspace ? { workspace: record.workspace } : {}),
      },
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
