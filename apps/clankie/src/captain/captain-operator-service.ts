import {
  hireDeliveryStage,
  OPERATOR_SEAT_HARNESSES,
  operatorFleetHome,
  operatorAutonomyCommandRequiresOwner,
  type OperatorConversation,
  type OperatorConversationServiceRequest,
  type OperatorConversationServiceResult,
  type OperatorFleetSeat,
} from "@clankie/protocol";
import { DEFAULT_PROJECT_ID } from "@clankie/protocol/projects";
import type { WorkerReportSummary } from "@clankie/protocol";
import { projectsRevision, SettingsStore, type ClankieSettings } from "@clankie/settings";
import { FleetMembershipReadError } from "../fleet-project-membership.ts";
import { splitFleetQualified } from "../herdr-fleet.ts";
import { HerdrUnavailableError } from "../herdr-session.ts";
import type { createAgentWorkStore } from "./agent-work.ts";
import { AutonomyStore } from "./autonomy.ts";
import { type CaptainOptions, type LaneSession } from "./captain-types.ts";
import { captainComposerCatalog, composerCatalogResponse, seatComposerCatalog } from "./composer-catalog.ts";
import {
  assertConversationAuthority,
  captureConversationAuthority,
  type ConversationOwner,
} from "./conversation-owner.ts";
import { authorizeQuestion, type QuestionAuthority } from "./conversation-questions.ts";
import { ConversationRefusedError, ConversationResetError, ConversationStore } from "./conversations.ts";
import type { CaptainDeps } from "./deps.ts";
import { DesktopExpressions } from "./desktop.ts";
import { readSeatIdForHerdrPane, type ObservedFleet, type ObservedHeadSeat } from "./herdr-census.ts";
import { FleetChangeClock } from "./herdr-fleet-changes.ts";
import { HerdrWatchStore, type HerdrAgentSnapshot, type HerdrWatchRunner } from "./herdr-watch.ts";
import { nativeConversationPage } from "./native-conversation.ts";
import { PersonaStore } from "./personas.ts";
import type { CaptainPort, HireSeat } from "./port.ts";
import { captainIsThinking, captainNativeSubagents, pollPresence, projectPresence } from "./presence.ts";
import { RuntimeTerminals } from "./runtime-terminals.ts";
import { type SeatLedger } from "./seat-ledger.ts";
import { SeatOutbox } from "./seat-outbox.ts";
import type { createStanceStore } from "./stances.ts";

export interface CreateOperatorServiceContext {
  readonly personas: PersonaStore;
  readonly settingsStore: SettingsStore;
  readonly deps: CaptainDeps;
  readonly seatOutboxes: Map<string, SeatOutbox>;
  readonly terminals: RuntimeTerminals;
  readonly conversations: ConversationStore;
  readonly autonomy: AutonomyStore;
  readonly settings: () => Promise<ClankieSettings>;
  readonly workingDirectory: string;
  readonly options: CaptainOptions;
  readonly refreshFleet: (options?: { force?: boolean }) => Promise<readonly OperatorFleetSeat[]>;
  liveSeats: readonly OperatorFleetSeat[];
  readonly fleetChanges: FleetChangeClock;
  readonly sessions: Map<string, Promise<LaneSession>>;
  readonly desktop: DesktopExpressions;
  readonly shutdown: AbortController;
  readonly fleetSnapshot: () => Promise<Extract<OperatorConversationServiceResult, { op: "fleet" }>>;
  readonly headSeat: ObservedHeadSeat | undefined;
  readonly observeFleet: (localOnly?: boolean) => Promise<ObservedFleet>;
  readonly agentWork: ReturnType<typeof createAgentWorkStore>;
  readonly stances: ReturnType<typeof createStanceStore>;
  readonly seatLedger: SeatLedger;
  readonly seatByPersona: Map<string, string>;
  readonly herdrWatches: HerdrWatchStore;
  readonly hireSeat: HireSeat;
  readonly seatSubjects: Map<string, string>;
  readonly herdrRunner: HerdrWatchRunner;
  readonly withDriver: (conversation: OperatorConversation) => OperatorConversation;
  readonly conversationGoal: (conversationId: string) =>
    | {
        objective: string;
        status:
          | "active"
          | "proposed"
          | "paused"
          | "blocked"
          | "budget_limited"
          | "usage_limited"
          | "complete";
        tokensUsed: number;
        createdAt: string;
        updatedAt: string;
        tokenBudget?: number | undefined;
        timeUsedSeconds?: number | undefined;
      }
    | undefined;
  readonly conversationAssignment: (
    conversationId: string,
  ) =>
    | { objective: string; updatedAt: string; issue?: { repoId: string; itemId: string } | undefined }
    | undefined;
  readonly validateConversationOwner: (owner: ConversationOwner) => Promise<boolean>;
  readonly reportSummaries: (conversationId?: string, native?: HerdrAgentSnapshot) => WorkerReportSummary[];
  readonly goalExecutionReason: (conversationId: string) => string | undefined;
}

export function createOperatorService(
  ctx: CreateOperatorServiceContext,
): CaptainPort["serveOperatorConversation"] {
  return async function serveOperatorConversation(
    request: OperatorConversationServiceRequest,
    authority?: QuestionAuthority,
  ): Promise<OperatorConversationServiceResult> {
    await ctx.personas.ready(ctx.settingsStore);
    if (
      ctx.deps.herdrAvailable?.() === false &&
      ["spawn_seat", "move_seat", "close_seat", "state_stance", "state_work"].includes(request.op)
    )
      throw new HerdrUnavailableError();
    if (ctx.deps.herdrAvailable?.() === false && request.op === "create" && request.scope.kind === "seat")
      throw new HerdrUnavailableError();
    if (request.op === "reset" && ctx.seatOutboxes.get(request.conversationId)?.bound()) {
      throw new ConversationResetError(
        "The conversation is bound to an external seat; end that seat before resetting its service context",
      );
    }
    if (request.op === "terminal_tail") {
      return {
        op: "terminal_tail",
        schemaVersion: 1,
        result: await ctx.terminals.tail(request.observation),
      };
    }
    if (request.op === "terminal_control") {
      return {
        op: "terminal_control",
        schemaVersion: 1,
        result: await ctx.terminals.control(request.control),
      };
    }
    if (request.op === "terminal_input") {
      return {
        op: "terminal_input",
        schemaVersion: 1,
        result: await ctx.terminals.input(request.input),
      };
    }
    if (request.op === "autonomy") {
      const requiresOwner = operatorAutonomyCommandRequiresOwner(request.command);
      if (requiresOwner && (!authority || !authority.current())) throw new Error("goal_owner_required");
      if (!ctx.conversations.has(request.conversationId)) {
        throw new Error(`Unknown conversation ${request.conversationId}`);
      }
      if (!ctx.conversations.runsCaptainTurns(request.conversationId)) {
        throw new Error("Only Clankie's own conversations have captain autonomy");
      }
      if (
        request.command.action === "set_goal" ||
        request.command.action === "accept_goal" ||
        (request.command.action === "set_goal_status" && request.command.status === "active")
      ) {
        await ctx.refreshFleet({ force: true });
        const reason = ctx.goalExecutionReason(request.conversationId);
        if (reason !== undefined) throw new ConversationRefusedError(reason);
      }
      // Revalidate the presented owner/device after asynchronous census, at
      // the activation boundary. A captain credential supplies no authority.
      if (requiresOwner && (!(await authority!.authorize()) || !authority!.current()))
        throw new Error("goal_owner_required");
      const status = ctx.autonomy.command(request.conversationId, request.command);
      if (request.command.action !== "status") ctx.fleetChanges.touch();
      return Promise.resolve({
        op: "autonomy",
        schemaVersion: 1,
        status,
      });
    }
    if (request.op === "composer_catalog") {
      const conversation = ctx.conversations.conversation(request.conversationId);
      if (conversation === undefined) throw new Error(`Unknown conversation ${request.conversationId}`);
      if (conversation.scope.kind === "global" || conversation.scope.kind === "workspace") {
        return {
          op: "composer_catalog",
          schemaVersion: 1,
          catalog: composerCatalogResponse(
            captainComposerCatalog({
              skills: (await ctx.settings()).skills,
              cwd:
                conversation.scope.kind === "workspace"
                  ? conversation.scope.workspaceId
                  : ctx.workingDirectory,
              repoRoot: ctx.options.repoRoot,
            }),
            request.includeQuickActions,
          ),
        };
      }
      await ctx.refreshFleet();
      const scope = conversation.scope;
      const seat =
        scope.kind === "persona"
          ? ctx.liveSeats.find((candidate) => candidate.personaId === scope.personaId)
          : scope.kind === "seat"
            ? ctx.liveSeats.find((candidate) => candidate.seatId === scope.seatId)
            : undefined;
      return {
        op: "composer_catalog",
        schemaVersion: 1,
        catalog: composerCatalogResponse(
          seat === undefined
            ? { schemaVersion: 1, commands: [], skills: [] }
            : await seatComposerCatalog(seat),
          request.includeQuickActions,
        ),
      };
    }
    if (
      request.op === "readopt_seat" ||
      request.op === "worker_reports" ||
      request.op === "acknowledge_worker_reports"
    ) {
      if (authority) await authorizeQuestion(authority);
      const owner: ConversationOwner = { conversationId: request.conversationId };
      const admitted = captureConversationAuthority({
        owner,
        current: () =>
          (authority?.current() ?? true) &&
          ctx.conversations.conversation(request.conversationId) !== undefined,
        authorize: async () => {
          if (authority) await authorizeQuestion(authority);
          return ctx.validateConversationOwner(owner);
        },
      });
      await assertConversationAuthority(admitted);
      if (request.op === "readopt_seat") {
        await ctx.herdrWatches.readoptSeat(request.seatId, admitted);
        ctx.fleetChanges.touch();
        return { op: request.op, schemaVersion: 1, seatId: request.seatId, adopted: true };
      }
      if (request.op === "worker_reports") {
        return {
          op: request.op,
          schemaVersion: 1,
          page: ctx.conversations.readInboundReports(
            request.conversationId,
            request.limit === undefined ? {} : { limit: request.limit },
          ),
        };
      }
      if (!ctx.conversations.acknowledgeInboundReports(request.conversationId, request.deliveryIds))
        throw new ConversationRefusedError("Only fully offered worker reports may be acknowledged");
      return {
        op: request.op,
        schemaVersion: 1,
        conversationId: request.conversationId,
        acknowledged: new Set(request.deliveryIds).size,
      };
    }
    if (request.op === "roster") {
      const seats = await ctx.refreshFleet();
      return {
        op: "roster",
        schemaVersion: 1,
        workerReports: ctx.reportSummaries(),
        seats:
          request.includeWork === true
            ? [...seats]
            : seats.map(({ goal: _goal, assignment: _assignment, ...seat }) => seat),
      };
    }
    if (request.op === "presence") {
      let seatCursor: string | undefined;
      let activeSeats = 0;
      const snapshot = await pollPresence(
        async () => {
          const currentSeatCursor = ctx.fleetChanges.current();
          if (seatCursor !== currentSeatCursor) {
            activeSeats = (await ctx.refreshFleet()).length;
            seatCursor = currentSeatCursor;
          }
          const [voice, play] = await Promise.all([
            ctx.deps.presence.listSessions(),
            ctx.deps.embodiment.getLiveSession(),
          ]);
          // Native children can change without a worker roster change. Re-observe
          // the captain parent on every sample rather than retaining its session.
          const { head } = await ctx.observeFleet(true);
          const nativeSubagents = await captainNativeSubagents(head, ctx.deps.agentSessions?.subagents);
          const thinking = await captainIsThinking(ctx.sessions.values());
          const inVoice = voice.some(
            (session) => session.gatewayConnected && session.voiceGuildIds.length > 0,
          );
          return projectPresence(
            {
              expression: await ctx.desktop.current(),
              thinking,
              working: head?.status === "working" || (nativeSubagents ?? 0) > 0,
              inVoice,
              playing:
                ctx.deps.hostedWorld?.inspect().outcome === "playing" ||
                (play !== undefined && ["running", "stopping"].includes(play.state)),
              ...(play === undefined ? {} : { playingSince: play.requestedAt }),
              activeSeats,
              ...(nativeSubagents === undefined ? {} : { nativeSubagents }),
              pendingOwnerItem: ctx.conversations.pendingPresenceOwnerItem(),
              ...ctx.conversations.recentPresenceActivity(),
            },
            request.includeFace === true,
          );
        },
        request.cursor,
        request.waitMs ?? 0,
        ctx.shutdown.signal,
      );
      return { op: "presence", schemaVersion: 1, snapshot };
    }
    if (request.op === "fleet") {
      await ctx.fleetChanges.wait(request.cursor, request.waitMs ?? 0);
      const snapshot = await ctx.fleetSnapshot();
      const { closedPanes: _closed, ...withoutHistory } = snapshot.snapshot;
      const full = request.includeClosedPanes ? snapshot : { ...snapshot, snapshot: withoutHistory };
      const { goals: _goals, assignments: _assignments, ...legacy } = full.snapshot;
      const result =
        request.includeWork === true
          ? full
          : {
              ...full,
              snapshot: {
                ...legacy,
                seats: legacy.seats.map(({ goal: _goal, assignment: _assignment, ...seat }) => seat),
              },
            };
      return request.view === "home" ? { ...result, snapshot: operatorFleetHome(result.snapshot) } : result;
    }
    if (request.op === "state_work") {
      const seatId = await readSeatIdForHerdrPane(
        request.work.herdrPaneId,
        ctx.options.nativeCensusRunner ? { runCommand: ctx.options.nativeCensusRunner } : {},
      );
      const seat =
        seatId === undefined
          ? undefined
          : (await ctx.refreshFleet({ force: true })).find((candidate) => candidate.seatId === seatId);
      const occupantId =
        seat?.occupantId ?? (seatId === ctx.headSeat?.seatId ? ctx.headSeat?.occupantId : undefined);
      if (occupantId === undefined || seatId === undefined)
        return {
          op: "state_work",
          schemaVersion: 1,
          result: { outcome: "unseated", herdrPaneId: request.work.herdrPaneId },
        };
      const assignment = ctx.agentWork.state(occupantId, request.work.assignment);
      ctx.fleetChanges.touch();
      return {
        op: "state_work",
        schemaVersion: 1,
        result:
          assignment === undefined
            ? { outcome: "cleared", seatId }
            : { outcome: "stated", seatId, assignment },
      };
    }
    if (request.op === "state_stance") {
      // The pane is the whole claim of identity, and it is checked against the
      // live census rather than believed — which is why this op is reachable
      // from the agent side at all (ADR 0148). A pane that holds no seat is
      // told so; it is a normal answer for a shell pane, not a failure.
      const seatId = await readSeatIdForHerdrPane(
        request.stance.herdrPaneId,
        ctx.options.nativeCensusRunner ? { runCommand: ctx.options.nativeCensusRunner } : {},
      );
      // The fleet is asked before anything is written, so a caller told
      // `unseated` knows nothing was recorded — a pane can be a live terminal
      // and still hold no seat the roster carries a figure for.
      const seat =
        seatId === undefined
          ? undefined
          : (await ctx.refreshFleet({ force: true })).find((candidate) => candidate.seatId === seatId);
      if (seat === undefined) {
        return {
          op: "state_stance",
          schemaVersion: 1,
          result: { outcome: "unseated", herdrPaneId: request.stance.herdrPaneId },
        };
      }
      const standing = ctx.stances.read(seat.seatId);
      const stance = ctx.stances.state(seat.seatId, request.stance);
      // The ship is the moment it says it landed something, not the whole
      // time the statement stands: restating a standing celebration is the
      // same landing, and counting it twice would be the host inflating it.
      if (stance.pose === "celebrate" && standing?.pose !== "celebrate") {
        ctx.seatLedger.shipped(seat.seatId);
      }
      ctx.fleetChanges.touch();
      const expires = setTimeout(
        () => ctx.fleetChanges.touch(),
        Math.max(0, Date.parse(stance.expiresAt) - Date.now()),
      );
      expires.unref();
      return {
        op: "state_stance",
        schemaVersion: 1,
        result: {
          outcome: "stated",
          seatId: seat.seatId,
          personaId: seat.personaId,
          stance,
        },
      };
    }
    if (request.op === "personas") {
      await ctx.refreshFleet();
      return {
        op: "personas",
        schemaVersion: 1,
        personas: [
          ...ctx.personas.all(ctx.liveSeats, (personaId) =>
            ctx.conversations.conversationForPersona(personaId),
          ),
        ],
      };
    }
    if (request.op === "update_persona") {
      const updated = ctx.personas.update(request.persona);
      ctx.conversations.renamePersona(updated.personaId, updated.name);
      ctx.fleetChanges.touch();
      return {
        op: "update_persona",
        schemaVersion: 1,
        persona: {
          ...updated,
          ...(ctx.seatByPersona.has(updated.personaId)
            ? { activeSeatId: ctx.seatByPersona.get(updated.personaId)! }
            : {}),
          conversationId: ctx.conversations.conversationIdForPersona(updated.personaId),
        },
      };
    }
    if (request.op === "roles") {
      return { op: "roles", schemaVersion: 1, roles: [...ctx.personas.roles()] };
    }
    if (request.op === "set_persona_role") {
      if (!ctx.personas.all([], () => undefined).some((persona) => persona.personaId === request.personaId))
        throw new Error(`Unknown agent ${request.personaId}`);
      const projectId = request.projectId ?? DEFAULT_PROJECT_ID;
      const seats = (await ctx.refreshFleet({ force: true })).filter(
        (seat) => seat.personaId === request.personaId,
      );
      const seat = seats.length === 1 ? seats[0] : undefined;
      const membership = ctx.options.fleetProjectMembership?.();
      if (!seat || seat.status === "offline" || !membership)
        throw new ConversationRefusedError(`Agent is not a confirmed current member of project ${projectId}`);
      const authorize = async () => {
        if (authority) await authorizeQuestion(authority);
        return true as const;
      };
      const qualified = splitFleetQualified(seat.seatId);
      const settings = await ctx.settingsStore.loadFenced();
      const snapshot = await membership
        .read(
          {
            schemaVersion: 1,
            seats: [
              {
                seatId: qualified?.id ?? seat.seatId,
                occupantId: seat.occupantId,
                fleet: qualified?.fleet ?? "default",
              },
            ],
          },
          new AbortController().signal,
          authorize,
        )
        .catch((error: unknown) => {
          if (error instanceof FleetMembershipReadError)
            throw new ConversationRefusedError(
              "Agent project membership is unavailable or changed; check the current project member",
            );
          throw error;
        });
      const observed = snapshot.seats[0];
      if (
        observed?.seatId !== (qualified?.id ?? seat.seatId) ||
        observed.occupantId !== seat.occupantId ||
        observed.membership.outcome !== "member" ||
        observed.membership.projectId !== projectId
      )
        throw new ConversationRefusedError(`Agent is not a confirmed current member of project ${projectId}`);
      if (projectsRevision(settings.settings.projects) !== snapshot.projectsRevision)
        throw new ConversationRefusedError("Project settings changed before role assignment");
      const updated = await ctx.personas.setProjectRole(
        {
          schemaVersion: 1,
          personaId: request.personaId,
          role: request.role,
          projectId,
        },
        () => {
          try {
            settings.assertCurrent();
          } catch {
            throw new ConversationRefusedError("Project settings changed before role assignment");
          }
          if (authority && !authority.current()) throw new Error("question_owner_unavailable");
          const current = ctx.liveSeats.filter((entry) => entry.personaId === request.personaId);
          if (
            current.length !== 1 ||
            current[0]!.seatId !== seat.seatId ||
            current[0]!.occupantId !== seat.occupantId ||
            ctx.personas.personaForOccupant(seat.occupantId) !== request.personaId
          )
            throw new ConversationRefusedError("Agent native identity changed before role assignment");
        },
        settings.settings.projects,
      );
      ctx.fleetChanges.touch();
      return {
        op: "set_persona_role",
        schemaVersion: 1,
        persona: {
          ...updated,
          ...(ctx.seatByPersona.has(updated.personaId)
            ? { activeSeatId: ctx.seatByPersona.get(updated.personaId)! }
            : {}),
          conversationId: ctx.conversations.conversationIdForPersona(updated.personaId),
        },
      };
    }
    if (request.op === "terminal_catalog") {
      return {
        op: "terminal_catalog",
        schemaVersion: 1,
        sessions: await ctx.terminals.catalog(),
      };
    }
    if (request.op === "settle_hire_receipt") {
      if (!authority) throw new ConversationRefusedError("Operator settlement authority is required");
      await authorizeQuestion(authority);
      return {
        op: "settle_hire_receipt",
        schemaVersion: 1,
        result: await ctx.herdrWatches.settleHireReceipt(
          request.receiptId,
          () => authorizeQuestion(authority),
          request.disposition,
        ),
      };
    }
    if (request.op === "close_seat") {
      const closed = await ctx.herdrWatches.closeSeat(request.seatId);
      if (closed) {
        const personaId = ctx.liveSeats.find((seat) => seat.seatId === request.seatId)?.personaId;
        if (personaId !== undefined) ctx.seatByPersona.delete(personaId);
        ctx.liveSeats = ctx.liveSeats.filter((seat) => seat.seatId !== request.seatId);
        ctx.fleetChanges.touch();
      }
      return {
        op: "close_seat",
        schemaVersion: 1,
        seatId: request.seatId,
        closed,
      };
    }
    if (request.op === "spawn_seat") {
      const conversationId = request.conversationId;
      if (conversationId === undefined || !ctx.conversations.runsCaptainTurns(conversationId))
        return {
          op: "spawn_seat",
          schemaVersion: 1,
          result: {
            outcome: "failed",
            reason: "not_ready",
            detail: "An exact authorized hiring conversationId is required",
          },
        };
      const hired = await ctx.hireSeat(request.seat, request.brief, {
        owner: { conversationId },
        current: () => ctx.conversations.runsCaptainTurns(conversationId),
        authorize: async () => ctx.conversations.runsCaptainTurns(conversationId),
      });
      const result = {
        ...hired,
        deliveryStage:
          hired.deliveryStage ??
          hireDeliveryStage(hired, hired.outcome === "spawned" || request.brief !== undefined),
      };
      return { op: "spawn_seat", schemaVersion: 1, result };
    }
    if (request.op === "move_seat") {
      const seat = ctx.liveSeats.find((current) => current.seatId === request.move.seatId);
      const subject = ctx.seatSubjects.get(request.move.seatId);
      if (seat === undefined || subject === undefined) {
        return {
          op: "move_seat",
          schemaVersion: 1,
          result: { outcome: "failed", reason: "unknown_seat", detail: request.move.seatId },
        };
      }
      // What the seat is saying about itself outlives the chair: the move is
      // the operator relocating a worker, not the worker changing its mind,
      // so the statement is carried with whatever life it had left.
      // The roster reports whatever harness herdr recognised; hiring only
      // accepts the ones it can start. A seat outside that list cannot be
      // rehired anywhere, and saying so beats a cast that pretends it can.
      const harness = OPERATOR_SEAT_HARNESSES.find((candidate) => candidate === seat.harness);
      if (harness === undefined) {
        return {
          op: "move_seat",
          schemaVersion: 1,
          result: { outcome: "failed", reason: "harness_unavailable", detail: seat.harness },
        };
      }
      const standing = ctx.stances.read(seat.seatId);
      const remainingMs = standing === undefined ? 0 : Date.parse(standing.expiresAt) - Date.now();
      const role = ctx.personas
        .all(ctx.liveSeats, () => undefined)
        .find((persona) => persona.personaId === seat.personaId)?.role;
      const moved = await ctx.herdrWatches.moveSeat({
        seatId: seat.seatId,
        subject,
        harness,
        title: seat.title,
        ...(role === undefined ? {} : { role }),
        workingDirectory: request.move.workingDirectory,
      });
      if (moved.outcome !== "spawned") {
        ctx.liveSeats = ctx.liveSeats.filter((current) => current.seatId !== seat.seatId);
        ctx.fleetChanges.touch();
        return { op: "move_seat", schemaVersion: 1, result: moved };
      }
      const rehired = ctx.personas.adoptSpawn(moved.seat, seat.title);
      ctx.conversations.bindPersona(rehired.personaId, rehired.seatId, seat.title);
      ctx.liveSeats = [
        ...ctx.liveSeats.filter((current) => current.personaId !== rehired.personaId),
        rehired,
      ];
      ctx.seatByPersona.set(rehired.personaId, rehired.seatId);
      ctx.seatSubjects.delete(seat.seatId);
      ctx.seatSubjects.set(rehired.seatId, subject);
      ctx.herdrWatches.trackSeat(rehired.seatId);
      rehired.conversationId = ctx.conversations.conversationIdForPersona(rehired.personaId);
      if (standing !== undefined && remainingMs > 0) {
        ctx.stances.state(rehired.seatId, {
          herdrPaneId: moved.seat.paneId,
          pose: standing.pose,
          ...(standing.note === undefined ? {} : { note: standing.note }),
          ttlMs: remainingMs,
        });
      }
      ctx.fleetChanges.touch();
      return { op: "move_seat", schemaVersion: 1, result: { outcome: "moved", seat: rehired } };
    }
    if (request.op === "connections")
      throw new Error("Connections are served by the authenticated app boundary");
    if (
      request.op === "work_repos" ||
      request.op === "work_items" ||
      request.op === "work_item_write" ||
      request.op === "work_item_write_receipt"
    )
      throw new Error("Work items are served by the authenticated app boundary");
    if (request.op === "subagent_replay") {
      const input = request.replay;
      const unavailable = (
        message: string,
        code: "unknown_conversation" | "run_conflict" = "run_conflict",
      ) => ({
        op: "subagent_replay" as const,
        schemaVersion: 1 as const,
        subagentId: input.subagentId,
        result: {
          schemaVersion: 1 as const,
          status: "recover" as const,
          conversationId: input.conversationId,
          code,
          recoverable: false,
          resetCursor: "0",
          message,
        },
      });
      const conversation = ctx.conversations.conversation(input.conversationId);
      const scope = conversation?.scope;
      if (!conversation || (scope?.kind !== "seat" && scope?.kind !== "persona"))
        return unavailable(
          "Open this agent's conversation before reading its subagents.",
          "unknown_conversation",
        );
      if (!ctx.deps.agentSessions?.readSubagent)
        return unavailable("This subagent's transcript is unavailable.");
      await ctx.refreshFleet();
      const previous = ctx.conversations.nativeSource(input.conversationId);
      const seatId =
        scope.kind === "seat"
          ? scope.seatId
          : (ctx.seatByPersona.get(scope.personaId) ?? previous?.terminalId);
      if (!seatId || splitFleetQualified(seatId))
        return unavailable("This subagent's transcript is unavailable.");
      const live = await ctx.herdrRunner.resolveTerminal(seatId).catch(() => undefined);
      const parent = live ?? previous;
      const key = (value: HerdrAgentSnapshot | undefined) =>
        value?.session === undefined
          ? undefined
          : JSON.stringify([value.agent, value.terminalId, value.session]);
      if (
        !parent?.session ||
        !["claude", "codex", "opencode"].includes(parent.agent) ||
        (previous?.session && live && key(previous) !== key(live))
      )
        return unavailable("The parent agent changed. Select its subagent again.");
      try {
        const page = await ctx.deps.agentSessions.readSubagent(
          parent.agent as "claude" | "codex" | "opencode",
          parent.session,
          input.subagentId,
          { tail: 500 },
        );
        const current = await ctx.herdrRunner.resolveTerminal(seatId).catch(() => undefined);
        const fresh = ctx.conversations.conversation(input.conversationId);
        if (
          !fresh ||
          JSON.stringify(fresh.scope) !== JSON.stringify(scope) ||
          (current && key(current) !== key(parent))
        )
          return unavailable("The parent agent changed. Select its subagent again.");
        ctx.conversations.rememberNativeSource(input.conversationId, parent);
        return {
          op: "subagent_replay",
          schemaVersion: 1,
          subagentId: input.subagentId,
          result: await nativeConversationPage(
            conversation,
            {
              sessionKey: `subagent:${page.session.ref}`,
              entries: page.entries.filter((entry) => entry.type !== "viewed_image"),
            },
            "idle",
            input,
          ),
        };
      } catch {
        // Locator errors never expose host paths or fall back to another child.
        return unavailable("This subagent's transcript is unavailable.");
      }
    }
    if (request.op === "replay" || request.op === "tail" || request.op === "react") {
      const input =
        request.op === "replay"
          ? request.replay
          : request.op === "tail"
            ? request.tail
            : {
                schemaVersion: 1 as const,
                conversationId: request.conversationId,
                surfaceClientId: "reaction",
                cursor: request.entryRef,
              };
      const conversation = ctx.conversations.conversation(input.conversationId);
      const scope = conversation?.scope;
      if (conversation !== undefined && (scope?.kind === "seat" || scope?.kind === "persona")) {
        const previous = ctx.conversations.nativeSource(input.conversationId);
        const seatId =
          scope.kind === "seat"
            ? scope.seatId
            : (ctx.seatByPersona.get(scope.personaId) ?? previous?.terminalId);
        if (seatId !== undefined) {
          const deadline = Date.now() + (request.op === "tail" ? Math.min(input.waitMs ?? 0, 25_000) : 0);
          for (;;) {
            const snapshot = await ctx.herdrWatches.readNativeChat(seatId, previous);
            if (snapshot === undefined) break;
            const cwd =
              ctx.liveSeats.find((seat) => seat.seatId === seatId)?.workingDirectory ??
              previous?.workingDirectory;
            const source = { ...snapshot.agent, ...(cwd === undefined ? {} : { workingDirectory: cwd }) };
            ctx.conversations.rememberNativeSource(input.conversationId, source);
            const page = await nativeConversationPage(
              conversation,
              snapshot.transcript,
              snapshot.agent.status,
              input,
              cwd === undefined || ctx.options.deliveredFiles === undefined || splitFleetQualified(seatId)
                ? undefined
                : (path) =>
                    ctx.options.deliveredFiles!.publish({
                      conversationId: input.conversationId,
                      sourceRoot: cwd,
                      path,
                    }),
              ctx.conversations.nativeAnnotations(input.conversationId),
            );
            if (request.op === "react")
              return {
                op: "react",
                schemaVersion: 1,
                conversationId: request.conversationId,
                entryRef: request.entryRef,
                reacted:
                  page.status === "page" &&
                  ctx.conversations.reactToNativeEntry(
                    request.conversationId,
                    request.entryRef,
                    request.emoji,
                    request.remove,
                  ),
              };
            if (
              page.status !== "page" ||
              page.events.length > 0 ||
              page.hasMore ||
              page.nextCursor !== input.cursor ||
              Date.now() >= deadline
            )
              return { op: request.op, schemaVersion: 1, result: page };
            await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, deadline - Date.now())));
          }
        }
      }
    }
    const result = await ctx.conversations.serve(request, authority);
    if (request.op === "create" && request.scope.kind === "seat") {
      ctx.herdrWatches.trackSeat(request.scope.seatId);
    } else if (request.op === "create" && request.scope.kind === "persona") {
      const seatId = ctx.seatByPersona.get(request.scope.personaId);
      if (seatId !== undefined) ctx.herdrWatches.trackSeat(seatId);
    }
    // Channel membership keeps roster status current; only an explicit room
    // prompt starts a bounded reply watch (ADR 0146).
    if (result.op === "channel") {
      for (const member of result.channel.members) {
        const seatId = ctx.seatByPersona.get(member.personaId);
        if (seatId !== undefined) ctx.herdrWatches.trackSeat(seatId);
      }
      ctx.fleetChanges.touch();
    } else if (request.op === "create" && request.scope.kind === "persona") {
      ctx.fleetChanges.touch();
    }
    if (result.op === "list" && request.op === "list")
      return {
        ...result,
        conversations: result.conversations.map((conversation) =>
          request.includeWork === true
            ? {
                ...ctx.withDriver(conversation),
                goal: ctx.conversationGoal(conversation.conversationId),
                assignment: ctx.conversationAssignment(conversation.conversationId),
              }
            : ctx.withDriver(conversation),
        ),
      };
    if (result.op === "get" && request.op === "get" && result.conversation !== undefined)
      return {
        ...result,
        conversation:
          request.includeWork === true
            ? {
                ...ctx.withDriver(result.conversation),
                goal: ctx.conversationGoal(result.conversation.conversationId),
                assignment: ctx.conversationAssignment(result.conversation.conversationId),
              }
            : ctx.withDriver(result.conversation),
      };
    return result;
  };
}
