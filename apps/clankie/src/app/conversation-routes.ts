import { SHIPPING_PATH, ShippingSnapshotSchema } from "@clankie/protocol/integrate";
import type { IssueWriteResult, PromptAnswerResult } from "@clankie/protocol/connector";
import { writeIssueForApp } from "../connector-issue-writes.ts";
import type { ConnectorPromptAnswers } from "./connector-prompt-answers.ts";
import {
  TRACKER_REQUEST_BUDGET_PATH,
  TrackerRequestBudgetReportSchema,
} from "@clankie/protocol/tracker-request-budget";
import { INBOX_TOOLS } from "@clankie/work-items";
import { createWorktreeCacheRoutes } from "../worktree-cache-routes.ts";
import { legacyWorkItem } from "@clankie/protocol/work-items";
import {
  CAPTAIN_LANE_OBSERVATION_PATH,
  CAPTAIN_TURN_METRICS_PATH,
  EVALUATOR_PATH,
  ROUTINES_PATH,
  RoutineCommandSchema,
  EvaluatorCommandSchema,
  HERDR_SOCKET_HEADER,
  ISSUE_METRICS_PATH,
  IssueMetricsQuerySchema,
  FEED_CHECK_ONE_SOURCE,
  FeedCheckRequestSchema,
  feedCheckHasOneSource,
  operatorAutonomyCommandRequiresOwner,
  operatorLeadCommandRequiresOwner,
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OPERATOR_DELIVERED_FILE_DOWNLOAD_PATH,
  OperatorConversationServiceRequestSchema,
  OperatorDeliveredFileDownloadRequestSchema,
  type AppNotesResult,
  type DeviceRecord,
  type DomainEvent,
  SERVICE_RESTARTING_SEAT_HANDOFF,
} from "@clankie/protocol";
import type {
  WorkItemWriteReceipt,
  WorkItemWriteReceiptRequest,
  WorkItemWriteRequest,
} from "@clankie/protocol/work-item-write";
import {
  FLEET_ROSTER_PATH,
  FLEET_ROSTER_RETIRE_PATH,
  FLEET_ROSTER_UNDO_PATH,
  RetireFleetAgentSchema,
  UndoFleetAgentSchema,
} from "@clankie/protocol/fleet-roster";
import { Hono } from "hono";
import { withLinearRequestInvocation } from "../linear-request-budget.ts";
import { isDeepStrictEqual } from "node:util";
import type { QuestionAuthority } from "../captain/conversation-questions.ts";
import { ConversationRefusedError, ConversationResetError } from "../captain/conversations.ts";
import { manageConnections } from "../connections.ts";
import { type DeviceRegistry } from "../devices.ts";
import { HerdrUnavailableError } from "../herdr-session.ts";
import { FleetRosterLimitError } from "../captain/herdr-census.ts";
import { ServiceShuttingDownError } from "../captain/captain-operator-service.ts";
import { WorkRequestError, type WorkInboxContext } from "../work-items.ts";
import { createOwnerFeed, FeedCursorError } from "../feed.ts";
import { createFeedDrops } from "../feed-drops.ts";
import { createFeedChecks } from "../feed-checks.ts";
import { CutoverRequestSchema } from "../linear-cutover.ts";
import type { WorkWriteAuthority } from "../work-write-target.ts";
import { FleetEfficiencyRequestSchema } from "../captain/fleet-efficiency-tools.ts";
import { RoutineError } from "../captain/routines.ts";
import { z } from "zod";
import { TRACKER_LEAD, TRACKER_OWNER, TrackerWriteRefused, type TrackerActor } from "@clankie/work-items";
import { authenticateCaptain, authenticateOperator, readJson } from "./http-auth.ts";
import { TrackerPostingStopped } from "../tracker-posting.ts";
import {
  TRACKER_POSTS_PATH,
  TrackerPostsRequestSchema,
  TrackerPostsResultSchema,
} from "@clankie/protocol/tracker-posting";
import { logger } from "./log.ts";
import { type ClankieAppDependencies, type DeviceAuthDenial, type TrustedDeviceIdentity } from "./types.ts";
export interface RegisterConversationRoutesContext {
  readonly app: Hono;
  readonly dependencies: ClankieAppDependencies;
  readonly authenticateDevice: (
    request: Request,
  ) => Promise<TrustedDeviceIdentity | "unavailable" | DeviceAuthDenial>;
  readonly devices: DeviceRegistry;
  /** Which connected apps the owner lets answer prompts in agent panes (ADR 0303). */
  readonly promptAnswers?: ConnectorPromptAnswers;
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
  const feedDrops = ctx.dependencies.workItems
    ? createFeedDrops({
        workItems: ctx.dependencies.workItems,
        ...(ctx.dependencies.settings ? { settings: ctx.dependencies.settings } : {}),
        ...(ctx.dependencies.deliveredFiles?.attachment
          ? {
              attachments: {
                attachment: ctx.dependencies.deliveredFiles.attachment.bind(ctx.dependencies.deliveredFiles),
              },
            }
          : {}),
        ...(ctx.dependencies.evidenceStore ? { evidence: ctx.dependencies.evidenceStore } : {}),
        wake: (...args) => ctx.dependencies.captain.wakeConversation(...args),
        ...(ctx.dependencies.trackerPosting ? { posting: ctx.dependencies.trackerPosting } : {}),
      })
    : undefined;
  const ownerFeed = createOwnerFeed({
    ...(ctx.dependencies.workItems ? { workItems: ctx.dependencies.workItems } : {}),
    ...(ctx.dependencies.settings ? { settings: ctx.dependencies.settings } : {}),
    ...(feedDrops ? { drops: feedDrops } : {}),
    ...(ctx.dependencies.builtInTracker ? { tracker: ctx.dependencies.builtInTracker } : {}),
    ...(ctx.dependencies.evidenceStore ? { evidence: ctx.dependencies.evidenceStore } : {}),
    now: () => ctx.clock().getTime(),
  });
  const feedChecks = createFeedChecks({
    ...(ctx.dependencies.settings ? { settings: ctx.dependencies.settings } : {}),
    ...(ctx.dependencies.evidenceStore ? { evidence: ctx.dependencies.evidenceStore } : {}),
    ...(ctx.dependencies.feedCheckReceiptPath === undefined
      ? {}
      : { receiptPath: ctx.dependencies.feedCheckReceiptPath }),
    // A check's key is its identity: an equal check under another key is its own ask,
    // so each key's retry finds the ask it made.
    requestOwnerAsk: (conversationId, draft, publicationId) =>
      ctx.dependencies.captain.requestOwnerAsk(conversationId, draft, publicationId, {
        exactPublication: true,
      }),
  });
  ctx.app.get(SHIPPING_PATH, async (context) => {
    context.header("cache-control", "no-store");
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (!operator || operator === "unavailable") {
      const device = await ctx.authenticateDevice(context.req.raw);
      if (device === "unavailable" || "denied" in device || !device.grants.terminalControl)
        return context.json({ error: "forbidden" }, 403);
      const record = ctx.devices.get(device.deviceId);
      if (!ownerDeviceRecord(record)) return context.json({ error: "forbidden" }, 403);
    }
    if (!ctx.dependencies.integration) return context.json({ error: "integration_unavailable" }, 503);
    return context.json(ShippingSnapshotSchema.parse(await ctx.dependencies.integration.shipping()));
  });
  for (const path of [FLEET_ROSTER_PATH, FLEET_ROSTER_RETIRE_PATH, FLEET_ROSTER_UNDO_PATH]) {
    ctx.app.on(path === FLEET_ROSTER_PATH ? "GET" : "POST", path, async (context) => {
      context.header("cache-control", "no-store");
      // Owner operator or a paired Take Control device; ordinary fleet workers and support reads are excluded.
      const authorize = async () => {
        const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
        if (operator && operator !== "unavailable") return true;
        const device = await ctx.authenticateDevice(context.req.raw);
        if (device === "unavailable" || "denied" in device || !device.grants.terminalControl) return false;
        const record = ctx.devices.get(device.deviceId);
        return ownerDeviceRecord(record);
      };
      if (!(await authorize())) return context.json({ error: "forbidden" }, 403);
      if (!ctx.dependencies.captain.fleetRoster || !ctx.dependencies.captain.fleetRosterAction)
        return context.json({ error: "fleet_roster_unavailable" }, 503);
      if (path === FLEET_ROSTER_PATH)
        return context.json(
          await ctx.dependencies.captain.fleetRoster({
            includeWork: context.req.query("includeWork") === "true",
          }),
        );
      const parsed = (
        path === FLEET_ROSTER_RETIRE_PATH ? RetireFleetAgentSchema : UndoFleetAgentSchema
      ).safeParse(await readJson(context.req.raw));
      if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
      let current = true;
      const result = await ctx.dependencies.captain.fleetRosterAction(parsed.data, {
        current: () => current && !context.req.raw.signal.aborted,
        authorize: async () => {
          current = await authorize();
          return current;
        },
      });
      return context.json(result);
    });
  }

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
  ctx.app.route(
    "/",
    createWorktreeCacheRoutes({
      authenticate: (request) => authenticateOperator(request, ctx.dependencies),
      ...(ctx.dependencies.captain.reclaimWorktreeCaches
        ? { reclaim: ctx.dependencies.captain.reclaimWorktreeCaches.bind(ctx.dependencies.captain) }
        : {}),
    }),
  );
  for (const action of ["sync", "prune"] as const) {
    ctx.app.post(`/v1/checkouts/${action}`, async (context) => {
      const identity = await authenticateOperator(context.req.raw, ctx.dependencies);
      if (!identity || identity === "unavailable")
        return context.json({ error: "operator_authentication_required" }, 401);
      const parsed = (
        action === "sync"
          ? z.strictObject({ repository: z.string().min(1).max(4096).optional() })
          : z.union([
              z.strictObject({ repository: z.string().min(1).max(4096), path: z.string().min(1).max(4096) }),
              z.strictObject({
                repository: z.string().min(1).max(4096),
                paths: z.array(z.string().min(1).max(4096)).min(1).max(64),
              }),
            ])
      ).safeParse(await readJson(context.req.raw));
      if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
      try {
        if (action === "sync") {
          if (!ctx.dependencies.captain.syncCheckouts)
            return context.json({ error: "checkouts_unavailable" }, 503);
          return context.json(await ctx.dependencies.captain.syncCheckouts(parsed.data.repository));
        }
        const { paths } = parsed.data as { paths?: string[] };
        if (paths) {
          if (!ctx.dependencies.captain.pruneWorktrees)
            return context.json({ error: "checkouts_unavailable" }, 503);
          return context.json(await ctx.dependencies.captain.pruneWorktrees(parsed.data.repository!, paths));
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
  /**
   * The owner's own app (ADR 0299): an active Take Control device that no hosted account,
   * support grant or automation run minted. Rechecked before every write it authorizes.
   */
  const ownerAppDevice = (deviceId: string): boolean => ownerAppRecord(ctx.devices.get(deviceId));
  /** Host-only ownerApp for a device principal that is the owner's own app; never for the operator bearer. */
  const ownerAppFor = (principal: { readonly kind: string; readonly id: string }) =>
    principal.kind === "device" && ownerAppDevice(principal.id) ? { deviceId: principal.id } : undefined;
  const questionOwnerAuthority = async (request: Request): Promise<QuestionAuthority | undefined> => {
    const deviceRequest = request;
    const device = await ctx.authenticateDevice(deviceRequest);
    if (device !== "unavailable" && !("denied" in device)) {
      const eligible = () => {
        const record = ctx.devices.get(device.deviceId);
        return record?.status === "active" && record.grants.terminalControl;
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
    const deviceRequest = request;
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
    if (typeof body === "object" && body !== null && (body as { op?: unknown }).op === "feed_check") {
      // An agent on this machine asks the owner for a quick check: this machine's
      // operator credential only, never a device, support grant or captain bearer.
      const asker = () => owner?.principal.kind === "operator" && owner.current();
      if (!owner) return context.json({ error: "operator_authority_required" }, 401);
      if (!asker() || !(await owner.authorize()))
        return context.json({ error: "operator_authority_required" }, 403);
      if (!parsed.success || parsed.data.op !== "feed_check") {
        // The asker learns exactly what to fix, such as the check line's 140-character limit.
        const checked = FeedCheckRequestSchema.extend({
          op: z.literal("feed_check"),
          schemaVersion: z.literal(1),
        })
          .strict()
          .refine(feedCheckHasOneSource, FEED_CHECK_ONE_SOURCE)
          .safeParse(body);
        const issue = checked.success ? undefined : checked.error.issues[0];
        const field = issue?.path.length ? `${issue.path.join(".")}: ` : "";
        return context.json(
          { error: "invalid_request", message: issue ? `${field}${issue.message}` : "Invalid check" },
          400,
        );
      }
      const { op: _op, schemaVersion: _version, ...request } = parsed.data;
      const reply = (result: import("@clankie/protocol").FeedCheckResult) =>
        context.json({ op: "feed_check", schemaVersion: 1, result });
      try {
        const result = await feedChecks.raise(request, (read) =>
          ctx.dependencies.captain.serveOperatorConversation(read, owner),
        );
        if (!asker() || !(await owner.authorize()))
          return context.json({ error: "operator_authority_required" }, 403);
        return reply(result);
      } catch (error) {
        if (!asker() || !(await owner.authorize()))
          return context.json({ error: "operator_authority_required" }, 403);
        logger.warn({ error }, "Owner check failed");
        return reply({
          outcome: "unavailable",
          message: "The check couldn’t be asked right now. Ask again with the same key.",
        });
      }
    }
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
    if (parsed.success && parsed.data.op === "lead_chats") {
      const ownerDevice = () => {
        if (owner?.principal.kind !== "device") return false;
        const record = ctx.devices.get(owner.principal.id);
        // Local pairing records the configured operator ID, not a fixed name.
        // Hosted visitor pairing uses the distinct "hosted-account" principal.
        return ownerDeviceRecord(record);
      };
      if (!ownerDevice() || !owner || !(await owner.authorize()))
        return context.json({ error: "owner_device_required" }, 403);
      try {
        if (!ctx.dependencies.captain.leadChats) throw new Error("Lead roster unavailable");
        const chats = await ctx.dependencies.captain.leadChats();
        if (!ownerDevice() || !(await owner.authorize()))
          return context.json({ error: "owner_device_required" }, 403);
        return context.json({ op: "lead_chats", schemaVersion: 1, result: { outcome: "ready", chats } });
      } catch {
        if (!ownerDevice() || !(await owner.authorize()))
          return context.json({ error: "owner_device_required" }, 403);
        return context.json({
          op: "lead_chats",
          schemaVersion: 1,
          result: { outcome: "unavailable", message: "The lead roster can’t be read here." },
        });
      }
    }
    if (parsed.success && parsed.data.op === "presence" && parsed.data.includeCurrentActivity === true) {
      context.header("cache-control", "private, no-store");
      const ownerReader = () => {
        if (!owner?.current()) return false;
        if (owner.principal.kind === "operator") return true;
        const record = ctx.devices.get(owner.principal.id);
        return ownerDeviceRecord(record);
      };
      if (!ownerReader() || !owner || !(await owner.authorize()))
        return context.json({ error: "owner_required" }, 403);
      const result = await ctx.dependencies.captain.serveOperatorConversation(parsed.data);
      if (!ownerReader() || !(await owner.authorize())) return context.json({ error: "owner_required" }, 403);
      return context.json(result);
    }
    if (parsed.success && parsed.data.op === "fleet_room") {
      // The room carries coordination text, so only the owner reads it (VUH-2184): a paired
      // device holding Take Control, or this machine's operator. Never a support grant, a
      // captain or worker bearer, or a room.
      const ownerReader = () => {
        if (!owner?.current()) return false;
        if (owner.principal.kind === "operator") return true;
        const record = ctx.devices.get(owner.principal.id);
        // Never a hosted visitor, whichever route its request took (as lead_chats).
        return ownerDeviceRecord(record);
      };
      const denied = () => context.json({ error: "owner_required" }, 403);
      if (!ownerReader() || !owner || !(await owner.authorize())) return denied();
      const { op: _op, schemaVersion: _version, ...request } = parsed.data;
      try {
        if (!ctx.dependencies.captain.fleetRoom) throw new Error("Fleet room unavailable");
        // A `newer` read may wait; authority is checked again before anything is returned.
        const result = await ctx.dependencies.captain.fleetRoom(request, context.req.raw.signal);
        if (!ownerReader() || !(await owner.authorize())) return denied();
        return context.json({ op: "fleet_room", schemaVersion: 1, result });
      } catch {
        if (!ownerReader() || !(await owner.authorize())) return denied();
        return context.json({
          op: "fleet_room",
          schemaVersion: 1,
          result: { outcome: "unavailable", message: "The fleet room can’t be read here." },
        });
      }
    }
    if (parsed.success && parsed.data.op === "app_notes") {
      // The app note board (ADR 0301). A connector app reaches it only through the relay,
      // which dispatches on its own captain bearer and stamps the device it authenticated
      // on a post. The author is named from that device's record here, never from the
      // caller's words. The owner reads it as the fleet room's reader does.
      const request = parsed.data;
      const relay = () =>
        captain !== undefined && captain !== "unavailable" && captain.steerSourceLane === "api";
      const author = () => {
        if (request.action !== "post" || request.appDeviceId === undefined) return undefined;
        const record = ctx.devices.get(request.appDeviceId);
        return record?.status === "active" && record.scope === "connector" ? record.name : undefined;
      };
      const ownerReader = () => {
        if (!owner?.current()) return false;
        if (owner.principal.kind === "operator") return true;
        return ownerDeviceRecord(ctx.devices.get(owner.principal.id));
      };
      const reply = (result: AppNotesResult) => context.json({ op: "app_notes", schemaVersion: 1, result });
      if (request.action === "post") {
        if (!relay() || author() === undefined) return context.json({ error: "app_author_required" }, 403);
      } else if (!relay() && !(ownerReader() && owner && (await owner.authorize())))
        return context.json({ error: "owner_required" }, 403);
      try {
        if (!ctx.dependencies.captain.appNotes) throw new Error("App notes unavailable");
        if (request.action === "read")
          return reply(
            await ctx.dependencies.captain.appNotes({
              action: "read",
              limit: request.limit,
              ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
            }),
          );
        // Named again at the write: a device revoked meanwhile posts nothing.
        const name = author();
        if (name === undefined) throw new Error("The app's device is no longer signed in");
        return reply(
          await ctx.dependencies.captain.appNotes({ action: "post", author: name, text: request.text }),
        );
      } catch {
        return reply({ outcome: "unavailable", message: "The note board can’t be reached here." });
      }
    }
    if (parsed.success && parsed.data.op === "prompt_answer") {
      // Answering a prompt in an agent's pane (ADR 0303). Like a note, it reaches the
      // service only through the relay's captain bearer, which stamps the connector
      // device it authenticated; the app is named from that device's own record, and
      // only an app the owner turned answering on for may press anything.
      const request = parsed.data;
      const relay = () =>
        captain !== undefined && captain !== "unavailable" && captain.steerSourceLane === "api";
      const app = () => {
        if (request.appDeviceId === undefined) return undefined;
        const record = ctx.devices.get(request.appDeviceId);
        return record?.status === "active" && record.scope === "connector" ? record : undefined;
      };
      const reply = (result: PromptAnswerResult) =>
        context.json({ op: "prompt_answer", schemaVersion: 1, result });
      const named = app();
      if (!relay() || named === undefined) return context.json({ error: "app_author_required" }, 403);
      if (ctx.promptAnswers?.allowed(named.deviceId) !== true)
        return reply({
          outcome: "refused",
          message: `The owner hasn't turned on answering prompts for ${named.name}. The owner turns it on at the Mac with: clankie connector prompts on "${named.name}"`,
        });
      if (!ctx.dependencies.captain.answerPrompt)
        return reply({
          outcome: "unavailable",
          message: "Answering prompts isn't available on this Clankie.",
        });
      try {
        return reply(
          await ctx.dependencies.captain.answerPrompt({
            app: named.name,
            // Rechecked before the first key: a revoked app or a switch turned off presses nothing.
            current: () => app() !== undefined && ctx.promptAnswers?.allowed(named.deviceId) === true,
            terminalId: request.terminalId,
            expect: request.expect,
            steps: request.steps,
          }),
        );
      } catch (error) {
        logger.warn({ error }, "Prompt answer failed");
        return reply({
          outcome: "uncertain",
          message: "The answer may or may not have reached the agent. Read its screen before trying again.",
        });
      }
    }
    if (parsed.success && parsed.data.op === "issue_write") {
      // A connected app writing an issue (ADR 0305): only through the relay's captain
      // bearer, which stamps the connector device it authenticated. The app is named from
      // that device's own record, and Linear or GitHub writes pass the project's setting.
      const request = parsed.data;
      const relay = () =>
        captain !== undefined && captain !== "unavailable" && captain.steerSourceLane === "api";
      const app = () => {
        if (request.appDeviceId === undefined) return undefined;
        const record = ctx.devices.get(request.appDeviceId);
        return record?.status === "active" && record.scope === "connector" ? record : undefined;
      };
      const reply = (result: IssueWriteResult) =>
        context.json({ op: "issue_write", schemaVersion: 1, result });
      const named = app();
      if (!relay() || named === undefined) return context.json({ error: "app_author_required" }, 403);
      if (ctx.dependencies.workItems === undefined)
        return reply({ outcome: "refused", message: "Work tracking is not running on this Clankie." });
      try {
        return reply(
          await writeIssueForApp(ctx.dependencies.workItems, {
            repoId: request.repoId,
            write: request.write,
            app: { deviceId: named.deviceId, name: named.name },
            current: () => app() !== undefined,
          }),
        );
      } catch (error) {
        logger.warn({ error }, "Connected app's issue write failed");
        return reply({
          outcome: "uncertain",
          message: "It may or may not have been written. Read the issue before trying again.",
        });
      }
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
      const deviceRequest = context.req.raw;
      const allowed = async () => {
        if (writing) return Boolean(authority && (await authority.authorize()));
        const device = await ctx.authenticateDevice(deviceRequest);
        if (device !== "unavailable" && !("denied" in device)) return device.grants.chat;
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
        // The owner's app, or Clankie for the owner on the operator bearer (LOCAL-VUH-1).
        const actor: TrackerActor | undefined = authority
          ? authority.principal.kind === "device"
            ? appActor(authority.principal.id)
            : CLANKIE_FOR_OWNER
          : undefined;
        const ownerApp = authority ? ownerAppFor(authority.principal) : undefined;
        const result = await tracker.sync(
          command,
          {
            ...(actor ? { actor } : {}),
            ...(ownerApp ? { ownerApp } : {}),
            beforeWrite: async () => {
              if (!(await allowed())) throw new Error("Owner authority expired");
              if (ownerApp && !ownerAppDevice(ownerApp.deviceId))
                throw new Error("Owner app authority expired");
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
      (parsed.data.op === "autonomy" && operatorAutonomyCommandRequiresOwner(parsed.data.command)) ||
      // Handing the lead back restarts Clankie's own turns (ADR 0304).
      (parsed.data.op === "lead" && operatorLeadCommandRequiresOwner(parsed.data.command));
    if (goalOwnerOp && !owner) return context.json({ error: "goal_owner_required" }, 403);
    const ownerHireOp = parsed.data.op === "spawn_seat" && parsed.data.seat.ownerWork !== undefined;
    if (ownerHireOp && !owner) return context.json({ error: "owner_hire_required" }, 403);
    const nativeMessageOp = parsed.data.op === "pending_messages" || parsed.data.op === "stop_task";
    if (nativeMessageOp && !owner) return context.json({ error: "operator_authority_required" }, 403);
    const questionOp =
      parsed.data.op === "project_proposal_get" ||
      parsed.data.op === "project_proposal_confirm" ||
      parsed.data.op === "project_proposal_tweak" ||
      parsed.data.op === "feed_list" ||
      parsed.data.op === "feed_drop" ||
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
      (ownerHireOp ||
        nativeMessageOp ||
        goalOwnerOp ||
        questionOp ||
        workerOwnerOp ||
        // The owner reads and sets who leads with their own credential.
        parsed.data.op === "lead" ||
        parsed.data.op === "send" ||
        parsed.data.op === "set_persona_role")
    ) {
      const binding = ctx.dependencies.herdrBinding?.();
      const sameSession =
        binding !== undefined
          ? context.req.header(HERDR_SOCKET_HEADER) === binding.socketPath
          : ctx.dependencies.herdrRuntime?.() === undefined;
      if (!sameSession && parsed.data.op === "send") delete parsed.data.turn.herdrPaneId;
      if (parsed.data.op === "feed_list") {
        // The feed joins the mailbox's own reads under the same owner, so the
        // store checks that authority on each; nothing returns once it lapses.
        const { op: _op, schemaVersion: _version, ...request } = parsed.data;
        const denied = () => context.json({ error: "question_owner_required" }, 403);
        try {
          const result = await ownerFeed.list(request, (read) =>
            ctx.dependencies.captain.serveOperatorConversation(read, owner),
          );
          if (!owner.current() || !(await owner.authorize())) return denied();
          return context.json({ op: "feed_list", schemaVersion: 1, result });
        } catch (error) {
          if (error instanceof FeedCursorError) return context.json({ error: "invalid_request" }, 400);
          if (!owner.current() || !(await owner.authorize())) return denied();
          if (error instanceof Error && error.message === "question_owner_unavailable") return denied();
          logger.warn({ error }, "Owner feed read failed");
          return context.json({
            op: "feed_list",
            schemaVersion: 1,
            result: { outcome: "unavailable", message: "The feed can’t be read right now. Read it again." },
          });
        }
      }
      if (parsed.data.op === "feed_drop") {
        // A drop writes into the owner's repo, so only the owner drops: this machine's
        // operator or a device the owner paired, never a support grant or a visitor.
        const { op: _op, schemaVersion: _version, ...request } = parsed.data;
        const denied = () => context.json({ error: "question_owner_required" }, 403);
        const dropper = () => {
          if (!owner.current()) return undefined;
          if (owner.principal.kind === "operator") return { source: { kind: "machine" as const } };
          const record = ctx.devices.get(owner.principal.id);
          return ownerDeviceRecord(record)
            ? {
                deviceId: record.deviceId,
                source: { kind: "device" as const, name: record.name, platform: record.platform },
              }
            : undefined;
        };
        const caller = dropper();
        if (caller === undefined || !(await owner.authorize())) return denied();
        const reply = (result: import("@clankie/protocol").FeedDropResult) =>
          context.json({ op: "feed_drop", schemaVersion: 1, result });
        if (feedDrops === undefined)
          return reply({ outcome: "unavailable", message: "Drops can’t be filed on this Clankie." });
        try {
          const result = await feedDrops.drop(request, {
            ...caller,
            serve: (read) => ctx.dependencies.captain.serveOperatorConversation(read, owner),
            guard: async () => {
              if (dropper() === undefined || !(await owner.authorize()))
                throw new Error("question_owner_unavailable");
            },
          });
          if (dropper() === undefined || !(await owner.authorize())) return denied();
          return reply(result);
        } catch (error) {
          if (dropper() === undefined || !(await owner.authorize())) return denied();
          logger.warn({ error }, "Owner drop failed");
          return reply({
            outcome: "unavailable",
            message: "The drop couldn’t be filed right now. Try again with the same key.",
          });
        }
      }
      try {
        return context.json(await ctx.dependencies.captain.serveOperatorConversation(parsed.data, owner));
      } catch (error) {
        if (error instanceof Error && error.message === "goal_owner_required")
          return context.json({ error: "goal_owner_required" }, 403);
        if (error instanceof Error && error.message === "question_owner_unavailable")
          return context.json({ error: "question_owner_required" }, 403);
        if (error instanceof ConversationRefusedError || error instanceof ConversationResetError)
          return context.json({ error: "refused", message: error.message }, 409);
        if (error instanceof ServiceShuttingDownError)
          return context.json(
            { error: "service_restarting", message: error.message, ...SERVICE_RESTARTING_SEAT_HANDOFF },
            503,
          );
        // Stop may already have sent Esc. Only request-schema rejection above
        // may return 400, which clients use to retry the legacy projection.
        if (parsed.data.op === "stop_task") {
          logger.warn({ error, conversationId: parsed.data.conversationId }, "Native Stop result uncertain");
          return context.json({ op: "stop_task", schemaVersion: 1, result: { outcome: "uncertain" } });
        }
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
    // Only links some returned item carried are fetched (VUH-2666); evidence links resolve to
    // recorded blobs. The device reads the bytes through evidence_preview and evidence_fetch.
    if (parsed.data.op === "work_media") {
      try {
        if (!ctx.dependencies.workMedia) throw new Error("Tracker media is not available on this host");
        return context.json({
          op: "work_media",
          schemaVersion: 1,
          result: { outcome: "ready", media: await ctx.dependencies.workMedia.resolve(parsed.data.urls) },
        });
      } catch {
        return context.json({
          op: "work_media",
          schemaVersion: 1,
          result: { outcome: "unavailable", message: "This work’s media can’t be read here." },
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
        ctx.dependencies.workMedia?.observe(result);
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
        ctx.dependencies.workMedia?.observe(result);
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
        const itemId = parsed.data.itemId;
        // A direct read reaches an item the repo's list would not (VUH-1954).
        const result = await withLinearRequestInvocation("background", async () => {
          if (itemId === undefined)
            return ctx.dependencies.workItems!.handle(
              { action: "list", repo: repoId, ...(label ? { label } : {}) },
              false,
            );
          try {
            const shown = await ctx.dependencies.workItems!.handle(
              { action: "show", repo: repoId, id: itemId },
              false,
            );
            if (!("item" in shown)) throw new Error("unexpected work result");
            return { repo: shown.repo, items: [shown.item] };
          } catch (error) {
            if (!(error instanceof WorkRequestError && error.code === "not_found")) throw error;
            const repos = await ctx.dependencies.workItems!.handle({ action: "repos" }, false);
            const repo = "repos" in repos ? repos.repos.find((entry) => entry.id === repoId) : undefined;
            if (repo === undefined) throw error;
            return { repo, items: [] };
          }
        });
        if (!("items" in result)) throw new Error("unexpected work result");
        ctx.dependencies.workMedia?.observe(result.items);
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
      if (error instanceof ServiceShuttingDownError)
        return context.json(
          { error: "service_restarting", message: error.message, ...SERVICE_RESTARTING_SEAT_HANDOFF },
          503,
        );
      if (error instanceof FleetRosterLimitError)
        return context.json(
          { error: "fleet_roster_limit", message: error.message, count: error.count, limit: error.limit },
          503,
        );
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

  /**
   * Routines (ADR 0265): GET lists; POST takes one RoutineCommand. Every UI uses this:
   * the owner directly, and a Take Control device through the relay, as the fleet roster.
   */
  ctx.app.on(["GET", "POST"], ROUTINES_PATH, async (context) => {
    context.header("cache-control", "no-store");
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (!operator || operator === "unavailable") {
      const device = await ctx.authenticateDevice(context.req.raw);
      if (device === "unavailable" || "denied" in device)
        return context.json({ error: "authentication_required" }, 401);
      if (!device.grants.terminalControl) return context.json({ error: "forbidden" }, 403);
    }
    const parsed =
      context.req.method === "GET"
        ? RoutineCommandSchema.safeParse({ action: "list" })
        : RoutineCommandSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success)
      return context.json(
        { error: "invalid_routine_command", message: parsed.error.issues[0]?.message },
        400,
      );
    try {
      return context.json(await ctx.dependencies.captain.routineCommand(parsed.data));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof RoutineError ? error.code : "refused";
      const status = code === "not_found" ? 404 : code === "invalid" ? 400 : code === "forbidden" ? 403 : 409;
      return context.json({ error: code, message }, status);
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
  /**
   * Built-in tracker calls from an authenticated owner principal. A terminalControl
   * device is always the owner's app. The operator bearer proves a local caller (the
   * lead seat, a hire, or the owner's own terminal), not the human at the keyboard, so
   * `/v1/tracker/call` (every `clankie work` tracker verb) is Clankie writing for the
   * owner (LOCAL-VUH-1). `/v1/tracker/owner/call` (`clankie work owner`) is the owner
   * speaking as himself (VUH-1917): owner activity that verifies, reopens and wakes.
   */
  const trackerCall = (path: string, operatorActor: TrackerActor) =>
    ctx.app.post(path, async (context) => {
      const tracker = ctx.dependencies.builtInTracker;
      if (tracker === undefined) return context.json({ error: "tracker_unavailable" }, 503);
      const authority = await questionOwnerAuthority(context.req.raw);
      if (authority === undefined) return context.json({ error: "owner_required" }, 401);
      const parsed = TrackerOwnerCallSchema.safeParse(await readJson(context.req.raw));
      if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
      if (!(await authority.authorize()) || !authority.current())
        return context.json({ error: "owner_required" }, 401);
      const actor = authority.principal.kind === "device" ? appActor(authority.principal.id) : operatorActor;
      const inboxCall = INBOX_TOOLS.has(parsed.data.name);
      const inbox: WorkInboxContext | undefined = inboxCall
        ? { authority, captain: ctx.dependencies.captain }
        : undefined;
      // Inbox reads are repository-scoped and never fall back to the unscoped tracker.
      if (inboxCall && parsed.data.repo === undefined)
        return context.json(
          { error: "tracker_refused", detail: "Inbox questions require a repository" },
          422,
        );
      try {
        if (parsed.data.repo !== undefined) {
          if (ctx.dependencies.workItems === undefined) throw new Error("Work tracking is unavailable");
          const result = await ctx.dependencies.workItems.callTracker(
            parsed.data.name,
            parsed.data.arguments,
            {
              repo: parsed.data.repo,
              local: authority.principal.kind !== "device",
              ...(inbox ? { inbox } : {}),
              actor,
              signal: context.req.raw.signal,
              beforeWrite: async () => {
                if (!(await authority.authorize()) || !authority.current())
                  throw new Error("Owner authority expired");
              },
            },
          );
          if (!(await authority.authorize()) || !authority.current())
            throw new Error("Owner authority expired");
          // The last await is behind us: recheck the live question/project/link fences before publishing.
          if (inbox) {
            if (!inbox.finalCheck) throw new Error("Inbox publication guard is unavailable");
            inbox.finalCheck();
          }
          return context.json({ result });
        }
        const ownerApp = ownerAppFor(authority.principal);
        const result = await tracker.call(parsed.data.name, parsed.data.arguments, {
          actor,
          ...(ownerApp ? { ownerApp } : {}),
          signal: context.req.raw.signal,
          beforeWrite: async () => {
            if (!(await authority.authorize()) || !authority.current())
              throw new Error("Owner authority expired");
            if (ownerApp && !ownerAppDevice(ownerApp.deviceId))
              throw new Error("Owner app authority expired");
          },
        });
        return context.json({ result });
      } catch (error) {
        if (inbox?.effect)
          return context.json(
            {
              error: "tracker_uncertain",
              mayHaveCommitted: true,
              idempotencyKey: inbox.idempotencyKey,
              detail:
                "Attention may have committed before current authority or data changed. Inspect current attention and the original write receipt; do not resend with a new key.",
            },
            409,
          );
        return context.json(
          {
            error: "tracker_refused",
            detail: error instanceof Error ? error.message : String(error),
            ...(error instanceof TrackerWriteRefused ? { reason: error.reason } : {}),
            ...(error instanceof TrackerPostingStopped
              ? { reason: error.reason, ...(error.post ? { post: error.post } : {}) }
              : {}),
          },
          422,
        );
      }
    });
  trackerCall(TRACKER_CALL_PATH, CLANKIE_FOR_OWNER);
  /**
   * `clankie work posts` (ADR 0302): writes waiting under "Posting to your tracker". The
   * operator bearer is Clankie (the lead seat, a hire or the owner's terminal): it lets
   * through or sends back only what waits for Clankie. What waits for the owner goes when
   * he answers its check in his feed, or from his own paired app here.
   */
  ctx.app.post(TRACKER_POSTS_PATH, async (context) => {
    const posting = ctx.dependencies.trackerPosting;
    if (posting === undefined) return context.json({ error: "posting_unavailable" }, 503);
    const authority = await questionOwnerAuthority(context.req.raw);
    if (authority === undefined) return context.json({ error: "owner_required" }, 401);
    const parsed = TrackerPostsRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    if (!(await authority.authorize()) || !authority.current())
      return context.json({ error: "owner_required" }, 401);
    const owner = authority.principal.kind === "device";
    if (owner && !ownerAppRecord(ctx.devices.get(authority.principal.id)))
      return context.json({ error: "owner_app_required" }, 403);
    try {
      return context.json(
        TrackerPostsResultSchema.parse(await posting.serve(parsed.data, owner ? "owner" : "lead")),
      );
    } catch (error) {
      if (error instanceof TrackerPostingStopped)
        return context.json({ error: error.reason, detail: error.message }, 409);
      throw error;
    }
  });
  trackerCall(TRACKER_OWNER_CALL_PATH, { ...TRACKER_OWNER, onBehalfOf: [] });
  // Hired seats' tracker budgets and role refusals (LOCAL-VUH-45), for doctor and work status.
  ctx.app.get(TRACKER_REQUEST_BUDGET_PATH, async (context) => {
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    if (!ctx.dependencies.trackerRequestBudget)
      return context.json({ error: "tracker_request_budget_unavailable" }, 503);
    return context.json(
      TrackerRequestBudgetReportSchema.parse(ctx.dependencies.trackerRequestBudget.report()),
    );
  });
  ctx.app.post("/v1/tracker/import/linear", async (context) => {
    const identity = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (!identity || identity === "unavailable") return context.json({ error: "operator_required" }, 401);
    const parsed = z
      .object({ projectId: z.string().uuid(), scratch: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u) })
      .strict()
      .safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    if (!ctx.dependencies.importLinear) return context.json({ error: "import_unavailable" }, 503);
    try {
      return context.json(
        await ctx.dependencies.importLinear(parsed.data.projectId, parsed.data.scratch, async () => {
          const current = await authenticateOperator(context.req.raw, ctx.dependencies);
          if (!current || current === "unavailable") throw new Error("Import authority expired");
        }),
      );
    } catch (error) {
      return context.json(
        { error: "linear_import_failed", detail: error instanceof Error ? error.message : String(error) },
        422,
      );
    }
  });
  // Mirror 2 (VUH-1965): the owner turns a scratch import's webhook mirror on or off.
  ctx.app.post("/v1/tracker/mirror/linear", async (context) => {
    const identity = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (!identity || identity === "unavailable") return context.json({ error: "operator_required" }, 401);
    const parsed = z
      .object({
        projectId: z.string().uuid(),
        scratch: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u),
        action: z.enum(["enable", "disable", "status"]),
      })
      .strict()
      .safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    if (!ctx.dependencies.linearMirrors) return context.json({ error: "mirror_unavailable" }, 503);
    try {
      return context.json(
        await ctx.dependencies.linearMirrors.configure(
          parsed.data.scratch,
          parsed.data.projectId,
          parsed.data.action,
        ),
      );
    } catch (error) {
      return context.json(
        { error: "linear_mirror_refused", detail: error instanceof Error ? error.message : String(error) },
        409,
      );
    }
  });
  // Mirror 3 (VUH-1987): the owner cuts a World project over to the built-in tracker,
  // or switches it back. A dry run reads only (Linear included) and prints every change.
  ctx.app.post("/v1/tracker/cutover/linear", async (context) => {
    const identity = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (!identity || identity === "unavailable") return context.json({ error: "operator_required" }, 401);
    const parsed = CutoverRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    if (!ctx.dependencies.linearCutover) return context.json({ error: "cutover_unavailable" }, 503);
    try {
      const result = (await ctx.dependencies.linearCutover.run(parsed.data)) as { ready: boolean };
      return context.json(result, result.ready || parsed.data.dryRun ? 200 : 409);
    } catch (error) {
      return context.json(
        { error: "linear_cutover_failed", detail: error instanceof Error ? error.message : String(error) },
        422,
      );
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
const TRACKER_CALL_PATH = "/v1/tracker/call";
/** Clankie (the lead) acting for the owner. */
const CLANKIE_FOR_OWNER: TrackerActor = { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] };
/**
 * A device the owner paired themselves: never a hosted visitor (`hosted-account`) or a support
 * session (a support grant or a `support:` mint). One rule for every owner-device route; the
 * verdict also refuses the owner's hosted pairings (ADR 0299).
 */
/**
 * The owner's own app (ADR 0299): an active Take Control device that no hosted account,
 * support grant or automation run minted.
 */
export function ownerAppRecord(record: DeviceRecord | undefined): boolean {
  return (
    ownerDeviceRecord(record) &&
    // A hosted pairing proves the hosted account, not this owner's hands, until ADR 0253's signer.
    record.mintedBy !== "hosted-account-operator" &&
    record.status === "active" &&
    record.grants.terminalControl &&
    record.run === undefined
  );
}

export function ownerDeviceRecord(record: DeviceRecord | undefined): record is DeviceRecord {
  return (
    record !== undefined &&
    record.supportGrantId === undefined &&
    record.mintedBy !== "hosted-account" &&
    !record.mintedBy.startsWith("support:")
  );
}
const appActor = (deviceId: string): TrackerActor => ({
  type: "app",
  id: `device:${deviceId}`,
  onBehalfOf: [TRACKER_OWNER],
});
const TrackerOwnerCallSchema = z
  .object({
    name: z.string().min(1).max(128),
    repo: z.string().min(1).max(4096).optional(),
    arguments: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
// Landing probe for the #52 test selection; reverted before merge.
