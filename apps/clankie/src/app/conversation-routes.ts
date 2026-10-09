import { legacyWorkItem } from "@clankie/protocol/work-items";
import {
  CAPTAIN_LANE_OBSERVATION_PATH,
  CAPTAIN_TURN_METRICS_PATH,
  EVALUATOR_PATH,
  EvaluatorCommandSchema,
  HERDR_SOCKET_HEADER,
  ISSUE_METRICS_PATH,
  IssueMetricsQuerySchema,
  operatorAutonomyCommandRequiresOwner,
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OPERATOR_DELIVERED_FILE_DOWNLOAD_PATH,
  OperatorConversationServiceRequestSchema,
  OperatorDeliveredFileDownloadRequestSchema,
  type DomainEvent,
} from "@clankie/protocol";
import type {
  WorkItemWriteReceipt,
  WorkItemWriteReceiptRequest,
  WorkItemWriteRequest,
} from "@clankie/protocol/work-item-write";
import { Hono } from "hono";
import { withLinearRequestInvocation } from "../linear-request-budget.ts";
import { isDeepStrictEqual } from "node:util";
import type { QuestionAuthority } from "../captain/conversation-questions.ts";
import { ConversationRefusedError, ConversationResetError } from "../captain/conversations.ts";
import { manageConnections } from "../connections.ts";
import { type DeviceRegistry } from "../devices.ts";
import { HerdrUnavailableError } from "../herdr-session.ts";
import { WorkRequestError } from "../work-items.ts";
import type { WorkWriteAuthority } from "../work-write-target.ts";
import { FleetEfficiencyRequestSchema } from "../captain/fleet-efficiency-tools.ts";
import { z } from "zod";
import { TRACKER_LEAD, TRACKER_OWNER, TrackerWriteRefused, type TrackerActor } from "@clankie/work-items";
import { authenticateCaptain, authenticateOperator, readJson } from "./http-auth.ts";
import { logger } from "./log.ts";
import { type ClankieAppDependencies, type DeviceAuthDenial, type TrustedDeviceIdentity } from "./types.ts";
export interface RegisterConversationRoutesContext {
  readonly app: Hono;
  readonly dependencies: ClankieAppDependencies;
  readonly hostedOriginalRequests: WeakMap<Request, Request>;
  readonly authenticateDevice: (
    request: Request,
  ) => Promise<TrustedDeviceIdentity | "unavailable" | DeviceAuthDenial>;
  readonly devices: DeviceRegistry;
  readonly hostedRequests: WeakMap<Request, string>;
  readonly clock: () => Date;
  readonly recordEvent: (
    type: string,
    streamId: string,
    occurredAt: string,
    data: Record<string, unknown>,
    envelope?: { correlationId?: string },
  ) => DomainEvent;
}

export function registerConversationRoutes(ctx: RegisterConversationRoutesContext) {
  for (const retire of [false, true]) {
    ctx.app.on(retire ? "POST" : "GET", `/v1/fleet/processes${retire ? "/retire" : ""}`, async (context) => {
      const identity = await authenticateOperator(context.req.raw, ctx.dependencies);
      if (!identity || identity === "unavailable")
        return context.json({ error: "operator_authentication_required" }, 401);
      if (retire && !z.strictObject({}).safeParse(await readJson(context.req.raw)).success)
        return context.json({ error: "invalid_request" }, 400);
      if (!ctx.dependencies.captain.harnessProcesses)
        return context.json({ error: "harness_processes_unavailable" }, 503);
      try {
        return context.json(await ctx.dependencies.captain.harnessProcesses(retire));
      } catch {
        return context.json({ error: "harness_process_observation_unavailable" }, 503);
      }
    });
  }
  ctx.app.post("/v1/fleet/efficiency", async (context) => {
    const identity = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (!identity || identity === "unavailable")
      return context.json({ error: "operator_authentication_required" }, 401);
    const parsed = FleetEfficiencyRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    if (!ctx.dependencies.captain.fleetEfficiency)
      return context.json({ error: "fleet_efficiency_unavailable" }, 503);
    try {
      const { action, conversationId } = parsed.data;
      const review =
        action === "review"
          ? (() => {
              const { action: _action, conversationId: _conversation, ...finding } = parsed.data;
              return finding;
            })()
          : undefined;
      return context.json(await ctx.dependencies.captain.fleetEfficiency(conversationId, review));
    } catch (error) {
      return context.json(
        { error: "refused", message: error instanceof Error ? error.message : "Review unavailable" },
        409,
      );
    }
  });
  ctx.app.post("/v1/fleet/tidy-worktrees", async (context) => {
    const identity = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (!identity || identity === "unavailable")
      return context.json({ error: "operator_authentication_required" }, 401);
    const parsed = z
      .strictObject({
        repository: z.string().min(1).max(4096),
        mergedInto: z.string().min(1).max(512).optional(),
      })
      .safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    if (!ctx.dependencies.captain.tidyWorktrees)
      return context.json({ error: "tidy_worktrees_unavailable" }, 503);
    return context.json(
      await ctx.dependencies.captain.tidyWorktrees(parsed.data.repository, parsed.data.mergedInto),
    );
  });

  ctx.app.get("/v1/checkouts", async (context) => {
    const identity = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (!identity || identity === "unavailable")
      return context.json({ error: "operator_authentication_required" }, 401);
    if (!ctx.dependencies.captain.checkoutReport)
      return context.json({ error: "checkouts_unavailable" }, 503);
    return context.json(await ctx.dependencies.captain.checkoutReport());
  });
  for (const action of ["sync", "prune"] as const) {
    ctx.app.post(`/v1/checkouts/${action}`, async (context) => {
      const identity = await authenticateOperator(context.req.raw, ctx.dependencies);
      if (!identity || identity === "unavailable")
        return context.json({ error: "operator_authentication_required" }, 401);
      const parsed = (
        action === "sync"
          ? z.strictObject({ repository: z.string().min(1).max(4096).optional() })
          : z.strictObject({ repository: z.string().min(1).max(4096), path: z.string().min(1).max(4096) })
      ).safeParse(await readJson(context.req.raw));
      if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
      try {
        if (action === "sync") {
          if (!ctx.dependencies.captain.syncCheckouts)
            return context.json({ error: "checkouts_unavailable" }, 503);
          return context.json(await ctx.dependencies.captain.syncCheckouts(parsed.data.repository));
        }
        if (!ctx.dependencies.captain.pruneWorktree)
          return context.json({ error: "checkouts_unavailable" }, 503);
        return context.json(
          await ctx.dependencies.captain.pruneWorktree(
            parsed.data.repository!,
            "path" in parsed.data && typeof parsed.data.path === "string" ? parsed.data.path : "",
          ),
        );
      } catch (error) {
        return context.json(
          {
            error: "refused",
            message: error instanceof Error ? error.message : "Checkout operation refused",
          },
          409,
        );
      }
    });
  }

  ctx.app.post("/v1/checkouts/decide", async (context) => {
    const identity = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (!identity || identity === "unavailable")
      return context.json({ error: "operator_authentication_required" }, 401);
    const parsed = z
      .strictObject({
        repository: z.string().min(1).max(4096),
        path: z.string().min(1).max(4096),
        decision: z.enum(["worth_landing", "safe_to_drop"]),
        reason: z.string().trim().min(1).max(512),
      })
      .safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    if (!ctx.dependencies.captain.decideWorktree)
      return context.json({ error: "checkouts_unavailable" }, 503);
    try {
      return context.json(await ctx.dependencies.captain.decideWorktree(parsed.data));
    } catch (error) {
      return context.json(
        { error: "refused", message: error instanceof Error ? error.message : "Decision refused" },
        409,
      );
    }
  });

  // The operator conversation contract (TUI direct, relay in front for
  // devices) and the lanes view — the captain's HTTP face. Both clients send
  // the shared captain token, the same credential the channel-turn door takes.
  ctx.app.post(OPERATOR_DELIVERED_FILE_DOWNLOAD_PATH, async (context) => {
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    if (ctx.dependencies.deliveredFiles === undefined) {
      return context.json({ error: "delivered_files_unavailable" }, 503);
    }
    const parsed = OperatorDeliveredFileDownloadRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    const found = await ctx.dependencies.deliveredFiles.read(
      parsed.data.conversationId,
      parsed.data.artifactId,
    );
    if (found === undefined) return context.json({ error: "artifact_unavailable" }, 404);
    return new Response(new Uint8Array(found.data), {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(found.file.filename)}`,
        "content-length": String(found.data.byteLength),
        "content-type": found.file.mediaType,
        "x-content-type-options": "nosniff",
      },
    });
  });

  /** Owner domain matches project/account writes; exact presented principal is revalidated each time. */
  const questionOwnerAuthority = async (request: Request): Promise<QuestionAuthority | undefined> => {
    const original = ctx.hostedOriginalRequests.get(request);
    const deviceRequest = original ?? request;
    const device = await ctx.authenticateDevice(deviceRequest);
    if (device !== "unavailable" && !("denied" in device)) {
      const eligible = () => {
        const record = ctx.devices.get(device.deviceId);
        return (
          record?.status === "active" &&
          record.grants.terminalControl &&
          (original === undefined || record.mintedBy === "hosted-account-operator")
        );
      };
      if (!eligible()) return undefined;
      return {
        principal: { kind: "device", id: device.deviceId },
        current: eligible,
        authorize: async () => {
          const fresh = await ctx.authenticateDevice(deviceRequest);
          return (
            fresh !== "unavailable" &&
            !("denied" in fresh) &&
            fresh.deviceId === device.deviceId &&
            fresh.grants.terminalControl &&
            eligible()
          );
        },
      };
    }
    // An inner hosted request cannot fall back to synthetic operator authority.
    if (original !== undefined || ctx.hostedRequests.has(request)) return undefined;
    const operator = await authenticateOperator(request, ctx.dependencies);
    if (!operator || operator === "unavailable") return undefined;
    let current = true;
    return {
      principal: { kind: "operator", id: operator.operatorId },
      current: () => current,
      authorize: async () => {
        const fresh = await authenticateOperator(request, ctx.dependencies);
        current = Boolean(fresh && fresh !== "unavailable" && fresh.operatorId === operator.operatorId);
        return current;
      },
    };
  };

  const workOwnerAuthority = async (request: Request): Promise<WorkWriteAuthority | undefined> => {
    const owner = await questionOwnerAuthority(request);
    if (!owner) return undefined;
    const original = ctx.hostedOriginalRequests.get(request);
    const deviceRequest = original ?? request;
    let expiresAt = Number.POSITIVE_INFINITY;
    if (owner.principal.kind === "device") {
      const device = await ctx.authenticateDevice(deviceRequest);
      if (device === "unavailable" || "denied" in device || device.deviceId !== owner.principal.id)
        return undefined;
      expiresAt = Date.parse(device.sessionExpiresAt);
    }
    const current = () =>
      !request.signal.aborted &&
      !deviceRequest.signal.aborted &&
      ctx.clock().getTime() < expiresAt &&
      owner.current();
    return {
      principal: owner.principal,
      current,
      authorize: async () => current() && (await owner.authorize()) && current(),
    };
  };
  const serveWorkWrite = async (
    request: WorkItemWriteRequest | WorkItemWriteReceiptRequest,
    authority: WorkWriteAuthority | undefined,
    write: boolean,
  ): Promise<WorkItemWriteReceipt> => {
    if (!authority)
      return {
        requestId: request.requestId,
        outcome: "refused",
        message: "An owner with terminal control must authorize this work-item write.",
      };
    if (!ctx.dependencies.workItems)
      return {
        requestId: request.requestId,
        outcome: "refused",
        message: "Work tracking is not running on this host.",
      };
    const audit = {
      principal: authority.principal,
      repoId: request.repoId,
      itemId: request.itemId,
      requestId: request.requestId,
    };
    if (write) {
      try {
        ctx.recordEvent("work.item.write.requested", `work:${request.repoId}`, ctx.clock().toISOString(), {
          ...audit,
          action: (request as WorkItemWriteRequest).command.action,
        });
      } catch {
        return {
          requestId: request.requestId,
          outcome: "refused",
          message: "The write could not be audited. Nothing was dispatched.",
        };
      }
    }
    const result = write
      ? await ctx.dependencies.workItems.handleOwnerWrite(
          request as WorkItemWriteRequest,
          authority,
          ctx.dependencies.captain?.prepareFreeAgentIntent,
          ctx.dependencies.captain?.prepareWorkHandoffIntent,
        )
      : await ctx.dependencies.workItems.readOwnerReceipt(request, authority);
    if (write) {
      try {
        ctx.recordEvent("work.item.write.resolved", `work:${request.repoId}`, ctx.clock().toISOString(), {
          ...audit,
          outcome: result.outcome,
        });
      } catch {
        logger.warn(
          { event: "work.item.write.audit_failed", requestId: request.requestId, outcome: result.outcome },
          "Work write settled in its durable receipt; outcome audit append failed",
        );
      }
    }
    return result;
  };

  ctx.app.post(OPERATOR_CONVERSATION_DISPATCH_PATH, async (context) => {
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    const owner = await questionOwnerAuthority(context.req.raw);
    const body = await readJson(context.req.raw);
    const parsed = OperatorConversationServiceRequestSchema.safeParse(body);
    // Narrow work refusals are typed receipts, so a device can render the reason
    // without confusing known non-dispatch with transport uncertainty.
    if (
      parsed.success &&
      (parsed.data.op === "work_item_write" || parsed.data.op === "work_item_write_receipt")
    ) {
      const authority = await workOwnerAuthority(context.req.raw);
      const request = parsed.data.op === "work_item_write" ? parsed.data.request : parsed.data;
      return context.json({
        op: parsed.data.op,
        schemaVersion: 1,
        outcome: "accepted",
        receipt: await serveWorkWrite(request, authority, parsed.data.op === "work_item_write"),
      });
    }
    if (parsed.success && parsed.data.op === "evidence_fetch") {
      // Media stays in the device's authenticated relay. Operator/captain tokens are not device authority.
      const ownerDevice = () =>
        owner?.principal.kind === "device" &&
        ctx.devices.get(owner.principal.id)?.supportGrantId === undefined;
      if (!ownerDevice() || !owner || !(await owner.authorize()))
        return context.json({ error: "owner_device_required" }, 403);
      try {
        const store = ctx.dependencies.evidenceStore;
        if (!store) throw new Error("Evidence unavailable");
        const { sha256, offset, length } = parsed.data;
        const result = await store.deviceFetch({ sha256, offset, length });
        if (!ownerDevice() || !(await owner.authorize()))
          return context.json({ error: "owner_device_required" }, 403);
        return context.json({
          op: "evidence_fetch",
          schemaVersion: 1,
          result: { outcome: "ready", ...result },
        });
      } catch {
        return context.json({
          op: "evidence_fetch",
          schemaVersion: 1,
          result: { outcome: "unavailable", message: "That evidence can’t be read here." },
        });
      }
    }
    if (parsed.success && parsed.data.op === "tracker_sync") {
      const tracker = ctx.dependencies.builtInTracker;
      const reply = (result: import("@clankie/protocol").TrackerSyncResult) =>
        context.json({ op: "tracker_sync" as const, schemaVersion: 1 as const, result });
      if (!tracker)
        return reply({
          outcome: "refused",
          reason: "tracker_unavailable",
          message: "Built-in tracker unavailable",
        });
      const command = parsed.data.command;
      const writing = command.action === "transaction";
      const authority = writing ? await workOwnerAuthority(context.req.raw) : undefined;
      const original = ctx.hostedOriginalRequests.get(context.req.raw);
      const deviceRequest = original ?? context.req.raw;
      const allowed = async () => {
        if (writing) return Boolean(authority && (await authority.authorize()));
        const device = await ctx.authenticateDevice(deviceRequest);
        if (device !== "unavailable" && !("denied" in device)) return device.grants.chat;
        if (original || ctx.hostedRequests.has(context.req.raw)) return false;
        const freshOwner = await authenticateOperator(context.req.raw, ctx.dependencies);
        if (freshOwner && freshOwner !== "unavailable") return true;
        const freshCaptain = await authenticateCaptain(context.req.raw, ctx.dependencies);
        return Boolean(
          freshCaptain && freshCaptain !== "unavailable" && freshCaptain.steerSourceLane === "api",
        );
      };
      if (!(await allowed()))
        return context.json({ error: writing ? "owner_required" : "authentication_required" }, 401);
      try {
        const actor: TrackerActor | undefined = authority
          ? authority.principal.kind === "device"
            ? { type: "app", id: `device:${authority.principal.id}`, onBehalfOf: [TRACKER_OWNER] }
            : { ...TRACKER_OWNER, onBehalfOf: [] }
          : undefined;
        const result = await tracker.sync(
          command,
          {
            ...(actor ? { actor } : {}),
            beforeWrite: async () => {
              if (!(await allowed())) throw new Error("Owner authority expired");
            },
          },
          context.req.raw.signal,
        );
        if (!(await allowed())) return context.json({ error: "authentication_required" }, 401);
        return reply(result);
      } catch (error) {
        return reply({
          outcome: "refused",
          reason: error instanceof TrackerWriteRefused ? error.reason : "invalid_request",
          message: error instanceof Error ? error.message : "Tracker sync refused",
        });
      }
    }
    if (!owner && (!captain || captain === "unavailable"))
      return context.json(
        {
          error:
            captain === "unavailable" ? "captain_execution_unavailable" : "captain_authentication_required",
        },
        captain === "unavailable" ? 503 : 401,
      );
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    if (parsed.data.op === "acknowledge_worker_report_history" && owner?.principal.kind !== "operator")
      return context.json({ error: "operator_authority_required" }, 403);
    const workerOwnerOp =
      parsed.data.op === "settle_hire_receipt" ||
      parsed.data.op === "settle_seat_delivery" ||
      parsed.data.op === "seat_deliveries" ||
      parsed.data.op === "seat_bridges" ||
      parsed.data.op === "readopt_seat" ||
      parsed.data.op === "worker_reports" ||
      parsed.data.op === "acknowledge_worker_reports" ||
      parsed.data.op === "acknowledge_worker_report_history";
    if (
      workerOwnerOp &&
      !owner &&
      (!captain || captain === "unavailable" || captain.steerSourceLane !== "api")
    )
      return context.json({ error: "operator_authority_required" }, 403);
    const goalOwnerOp =
      parsed.data.op === "autonomy" && operatorAutonomyCommandRequiresOwner(parsed.data.command);
    if (goalOwnerOp && !owner) return context.json({ error: "goal_owner_required" }, 403);
    const nativeMessageOp = parsed.data.op === "pending_messages" || parsed.data.op === "stop_task";
    if (nativeMessageOp && !owner) return context.json({ error: "operator_authority_required" }, 403);
    const questionOp =
      parsed.data.op === "project_proposal_get" ||
      parsed.data.op === "project_proposal_confirm" ||
      parsed.data.op === "project_proposal_tweak" ||
      parsed.data.op === "owner_update_list" ||
      parsed.data.op === "owner_update_read" ||
      parsed.data.op === "owner_update_dismiss" ||
      parsed.data.op === "input_list" ||
      parsed.data.op === "input_get" ||
      parsed.data.op === "input_answer" ||
      parsed.data.op === "input_cancel";
    if (questionOp && !owner) return context.json({ error: "question_owner_required" }, 403);
    if (
      owner &&
      (nativeMessageOp ||
        goalOwnerOp ||
        questionOp ||
        workerOwnerOp ||
        parsed.data.op === "send" ||
        parsed.data.op === "set_persona_role")
    ) {
      const binding = ctx.dependencies.herdrBinding?.();
      const sameSession =
        binding !== undefined
          ? context.req.header(HERDR_SOCKET_HEADER) === binding.socketPath
          : ctx.dependencies.herdrRuntime?.() === undefined;
      if (!sameSession && parsed.data.op === "send") delete parsed.data.turn.herdrPaneId;
      try {
        return context.json(await ctx.dependencies.captain.serveOperatorConversation(parsed.data, owner));
      } catch (error) {
        if (error instanceof Error && error.message === "goal_owner_required")
          return context.json({ error: "goal_owner_required" }, 403);
        if (error instanceof Error && error.message === "question_owner_unavailable")
          return context.json({ error: "question_owner_required" }, 403);
        if (error instanceof ConversationRefusedError || error instanceof ConversationResetError)
          return context.json({ error: "refused", message: error.message }, 409);
        throw error;
      }
    }
    if (!captain || captain === "unavailable")
      return context.json({ error: "captain_authentication_required" }, 401);
    if (parsed.data.op === "connections") {
      if (captain.steerSourceLane !== "api")
        return context.json({ error: "operator_authority_required" }, 403);
      try {
        return context.json({
          op: "connections",
          schemaVersion: 1,
          result: {
            outcome: "ready",
            inventory: await manageConnections(ctx.dependencies, parsed.data.command),
          },
        });
      } catch {
        return context.json({
          op: "connections",
          schemaVersion: 1,
          result: {
            outcome: "refused",
            message:
              "Connection change or inventory unavailable. Refresh to inspect current state; check the host's connection diagnostics before retrying.",
          },
        });
      }
    }
    // Work items are read here, beside the registry that decides which repos a
    // device may name (ADR 0191). Owner writes use the separate journaled route above.
    if (parsed.data.op === "work_repos") {
      const result =
        ctx.dependencies.workItems === undefined
          ? { repos: [] }
          : await ctx.dependencies.workItems.handle({ action: "repos" }, false);
      return context.json({
        op: "work_repos",
        schemaVersion: 1,
        repos: "repos" in result ? result.repos : [],
      });
    }
    if (parsed.data.op === "work_project") {
      try {
        if (!ctx.dependencies.workItems) throw new Error("Work tracking is not running on this host");
        const result = await ctx.dependencies.workItems.handle(
          { action: "project", repo: parsed.data.repoId },
          false,
        );
        if (!("releaseSource" in result)) throw new Error("Unexpected project work result");
        return context.json({
          op: "work_project",
          schemaVersion: 1,
          result: { outcome: "ready", ...result },
        });
      } catch {
        return context.json({
          op: "work_project",
          schemaVersion: 1,
          result: {
            outcome: "unavailable",
            message: "This project’s saved work tracker can’t be read here. Read the work again.",
          },
        });
      }
    }
    // The evidence store's records and small previews for paired devices (VUH-1936);
    // the bearer HTTP routes stay operator-only.
    if (parsed.data.op === "evidence_records") {
      try {
        const store = ctx.dependencies.evidenceStore;
        if (!store) throw new Error("No evidence store on this host");
        const records = await store.list({ issueKey: parsed.data.issueKey });
        return context.json({
          op: "evidence_records",
          schemaVersion: 1,
          result: { outcome: "ready", records: records.slice(-500) },
        });
      } catch {
        return context.json({
          op: "evidence_records",
          schemaVersion: 1,
          result: { outcome: "unavailable", message: "This Clankie’s evidence can’t be read right now." },
        });
      }
    }
    if (parsed.data.op === "evidence_preview") {
      try {
        const store = ctx.dependencies.evidenceStore;
        if (!store) throw new Error("No evidence store on this host");
        const preview = await store.devicePreview(parsed.data.sha256);
        return context.json({
          op: "evidence_preview",
          schemaVersion: 1,
          result: { outcome: "ready", ...preview },
        });
      } catch {
        return context.json({
          op: "evidence_preview",
          schemaVersion: 1,
          result: { outcome: "unavailable", message: "That evidence can’t be shown here." },
        });
      }
    }
    if (parsed.data.op === "work_project_details") {
      try {
        if (!ctx.dependencies.workItems) throw new Error("Work tracking is not running on this host");
        const result = await ctx.dependencies.workItems.handle(
          { action: "project-details", repo: parsed.data.repoId },
          false,
        );
        if (!("updates" in result)) throw new Error("Unexpected project details result");
        return context.json({
          op: "work_project_details",
          schemaVersion: 1,
          result: { outcome: "ready", ...result },
        });
      } catch {
        return context.json({
          op: "work_project_details",
          schemaVersion: 1,
          result: {
            outcome: "unavailable",
            message: "This project’s details can’t be read here. Read the work again.",
          },
        });
      }
    }
    if (parsed.data.op === "work_item_activity") {
      try {
        if (!ctx.dependencies.workItems) throw new Error("Work tracking is not running on this host");
        const result = await ctx.dependencies.workItems.handle(
          { action: "activity", repo: parsed.data.repoId, id: parsed.data.itemId },
          false,
        );
        if (!("entries" in result)) throw new Error("Unexpected work activity result");
        return context.json({
          op: "work_item_activity",
          schemaVersion: 1,
          result: { outcome: "ready", ...result },
        });
      } catch {
        return context.json({
          op: "work_item_activity",
          schemaVersion: 1,
          result: {
            outcome: "unavailable",
            message: "This item’s comments can’t be read here. Read the work again.",
          },
        });
      }
    }
    if (parsed.data.op === "work_items") {
      const repoId = parsed.data.repoId;
      if (ctx.dependencies.workItems === undefined)
        return context.json({
          op: "work_items",
          schemaVersion: 1,
          result: { outcome: "unavailable", message: "Work tracking is not running on this host" },
        });
      try {
        const label = parsed.data.label?.trim();
        const result = await withLinearRequestInvocation("background", () =>
          ctx.dependencies.workItems!.handle(
            { action: "list", repo: repoId, ...(label ? { label } : {}) },
            false,
          ),
        );
        if (!("items" in result)) throw new Error("unexpected work result");
        return context.json({
          op: "work_items",
          schemaVersion: 1,
          result: {
            outcome: "ready",
            repo: result.repo,
            items: parsed.data.statusVersion === 2 ? result.items : result.items.map(legacyWorkItem),
          },
        });
      } catch (error) {
        if (error instanceof WorkRequestError && error.code === "needs_decision") {
          const repos = await ctx.dependencies.workItems.handle({ action: "repos" }, false);
          const repo = "repos" in repos ? repos.repos.find((entry) => entry.id === repoId) : undefined;
          if (repo !== undefined)
            return context.json({
              op: "work_items",
              schemaVersion: 1,
              result: {
                outcome: "needs_decision",
                repo,
                question: error.question ?? error.message,
                signals: (error.signals ?? []).slice(0, 20),
              },
            });
        }
        return context.json({
          op: "work_items",
          schemaVersion: 1,
          result: {
            outcome: "unavailable",
            message: (error instanceof Error ? error.message : "Unavailable").slice(0, 1000),
          },
        });
      }
    }
    // Pane IDs are local to their source session, in both runtime modes.
    const binding = ctx.dependencies.herdrBinding?.();
    const sameHerdrSession =
      binding !== undefined
        ? context.req.header(HERDR_SOCKET_HEADER) === binding.socketPath
        : ctx.dependencies.herdrRuntime?.() === undefined;
    if (!sameHerdrSession) {
      if (parsed.data.op === "send") delete parsed.data.turn.herdrPaneId;
      if (parsed.data.op === "state_stance" || parsed.data.op === "state_work") {
        return context.json({ error: "herdr_session_mismatch" }, 409);
      }
    }
    try {
      let roleAuthority: QuestionAuthority | undefined;
      if (parsed.data.op === "set_persona_role" || workerOwnerOp) {
        let current = true;
        const original = structuredClone(captain);
        roleAuthority = {
          principal: { kind: "operator", id: captain.captainId },
          current: () => current,
          authorize: async () => {
            const fresh = await authenticateCaptain(context.req.raw, ctx.dependencies);
            current = !!fresh && fresh !== "unavailable" && isDeepStrictEqual(fresh, original);
            return current;
          },
        };
      }
      return context.json(
        await ctx.dependencies.captain.serveOperatorConversation(
          parsed.data,
          roleAuthority,
          parsed.data.op === "tail" ? context.req.raw.signal : undefined,
        ),
      );
    } catch (error) {
      if (parsed.data.op === "tail" && context.req.raw.signal.aborted)
        return new Response(null, { status: 499 });
      if (error instanceof Error && error.message === "goal_owner_required")
        return context.json({ error: "goal_owner_required" }, 403);
      if (error instanceof Error && error.message === "question_owner_unavailable")
        return context.json({ error: "captain_authentication_required" }, 403);
      if (error instanceof HerdrUnavailableError)
        return context.json({ error: "herdr_unavailable", message: error.message }, 503);
      if (error instanceof ConversationResetError)
        return context.json({ error: "reset_refused", message: error.message }, 409);
      if (error instanceof ConversationRefusedError)
        return context.json({ error: "refused", message: error.message }, 409);
      throw error;
    }
  });

  ctx.app.get(CAPTAIN_LANE_OBSERVATION_PATH, async (context) => {
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    return context.json({ schemaVersion: 1 as const, lanes: await ctx.dependencies.captain.observeLanes() });
  });

  /**
   * Recent settled-turn metrics (VUH-1115): what ran each turn, what it did, and
   * what the provider reported. Bounded on read; `limit` is clamped rather than
   * refused so a caller can never ask for the whole log.
   */
  ctx.app.on(["GET", "POST"], EVALUATOR_PATH, async (context) => {
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    if (context.req.method === "GET") return context.json(ctx.dependencies.captain.evaluatorStatus());
    const parsed = EvaluatorCommandSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "invalid_evaluator_command" }, 400);
    try {
      return context.json(await ctx.dependencies.captain.evaluatorCommand(parsed.data));
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  ctx.app.get(ISSUE_METRICS_PATH, async (context) => {
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const parsed = IssueMetricsQuerySchema.safeParse(context.req.query());
    if (!parsed.success) return context.json({ error: "invalid_metrics_query" }, 400);
    try {
      return context.json(await ctx.dependencies.captain.readIssueMetrics(parsed.data));
    } catch (error) {
      if (error instanceof RangeError) return context.json({ error: error.message }, 400);
      throw error;
    }
  });

  ctx.app.get(CAPTAIN_TURN_METRICS_PATH, async (context) => {
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const requested = context.req.query("limit");
    const limit = requested === undefined || requested.length === 0 ? Number.NaN : Number(requested);
    const runId = context.req.query("runId");
    const items = await ctx.dependencies.captain.readTurnMetrics({
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(runId === undefined || runId.length === 0 ? {} : { runId }),
    });
    return context.json({ schemaVersion: 1 as const, items });
  });
  // The owner's own writes to the built-in tracker (VUH-1917). The actor comes from
  // authentication: the operator is the human owner, a terminalControl device is the
  // owner's app. These are owner activity, so they can wake the item's routed chat.
  ctx.app.post(TRACKER_OWNER_CALL_PATH, async (context) => {
    const tracker = ctx.dependencies.builtInTracker;
    if (tracker === undefined) return context.json({ error: "tracker_unavailable" }, 503);
    const authority = await questionOwnerAuthority(context.req.raw);
    if (authority === undefined) return context.json({ error: "owner_required" }, 401);
    const parsed = TrackerOwnerCallSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    if (!(await authority.authorize()) || !authority.current())
      return context.json({ error: "owner_required" }, 401);
    const actor: TrackerActor =
      authority.principal.kind === "device"
        ? { type: "app", id: `device:${authority.principal.id}`, onBehalfOf: [TRACKER_OWNER] }
        : { ...TRACKER_OWNER, onBehalfOf: [] };
    try {
      const result = await tracker.call(parsed.data.name, parsed.data.arguments, {
        actor,
        beforeWrite: async () => {
          if (!(await authority.authorize()) || !authority.current())
            throw new Error("Owner authority expired");
        },
      });
      return context.json({ result });
    } catch (error) {
      return context.json(
        { error: "tracker_refused", detail: error instanceof Error ? error.message : String(error) },
        422,
      );
    }
  });
  ctx.app.post("/v1/tracker/import/linear", async (context) => {
    const identity = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (!identity || identity === "unavailable") return context.json({ error: "operator_required" }, 401);
    const parsed = z.object({ projectId: z.string().uuid(), scratch: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u) }).strict().safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    if (!ctx.dependencies.importLinear) return context.json({ error: "import_unavailable" }, 503);
    try {
      return context.json(await ctx.dependencies.importLinear(parsed.data.projectId, parsed.data.scratch, async () => {
        const current = await authenticateOperator(context.req.raw, ctx.dependencies);
        if (!current || current === "unavailable") throw new Error("Import authority expired");
      }));
    } catch (error) {
      return context.json({ error: "linear_import_failed", detail: error instanceof Error ? error.message : String(error) }, 422);
    }
  });
  // Releases (VUH-1930): git decides what shipped; the owner only says which repository
  // to read. Clankie records the derived versions and the stage events they cause.
  ctx.app.post(TRACKER_RELEASE_SYNC_PATH, async (context) => {
    const tracker = ctx.dependencies.builtInTracker;
    const workItems = ctx.dependencies.workItems;
    if (tracker === undefined || workItems === undefined)
      return context.json({ error: "tracker_unavailable" }, 503);
    const authority = await questionOwnerAuthority(context.req.raw);
    if (authority === undefined) return context.json({ error: "owner_required" }, 401);
    const parsed = TrackerReleaseSyncSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    if (!(await authority.authorize()) || !authority.current())
      return context.json({ error: "owner_required" }, 401);
    let history;
    try {
      // A device names a registered repository; the operator on this machine may name a path.
      history = await workItems.releaseHistory(parsed.data.repo, authority.principal.kind !== "device");
    } catch (error) {
      return context.json(
        { error: "releases_unavailable", detail: error instanceof Error ? error.message : String(error) },
        422,
      );
    }
    try {
      const result = await tracker.syncReleases(history, {
        actor: { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] },
        via: "release",
        beforeWrite: async () => {
          if (!(await authority.authorize()) || !authority.current())
            throw new Error("Owner authority expired");
        },
      });
      return context.json({ result });
    } catch (error) {
      return context.json(
        { error: "tracker_refused", detail: error instanceof Error ? error.message : String(error) },
        422,
      );
    }
  });
  return { questionOwnerAuthority, workOwnerAuthority, serveWorkWrite };
}

const TRACKER_RELEASE_SYNC_PATH = "/v1/tracker/releases/sync";
const TrackerReleaseSyncSchema = z.object({ repo: z.string().min(1).max(4096) }).strict();
const TRACKER_OWNER_CALL_PATH = "/v1/tracker/owner/call";
const TrackerOwnerCallSchema = z
  .object({
    name: z.string().min(1).max(128),
    arguments: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
