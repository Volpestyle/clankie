import { verifyRemoteHireCheckout } from "./checkout-freshness.ts";
import { verifyHireCheckout, projectPathContains, type HireCheckoutFreshness } from "@clankie/settings";
import { HireWorktrees, hireWorktreeScope, type HireWorktreeRelocation } from "./hire-worktrees.ts";
import { managedWorktreePaths } from "./tidy-worktrees.ts";
import { formatFleetAutonomyGuidance } from "@clankie/protocol";
import { type FleetRoomParty } from "@clankie/protocol";
import { autoHireAuthority } from "./auto-hire-policy.ts";
import { effectiveFleetAutonomy } from "@clankie/settings";
import type { ProjectHirePolicy } from "./herdr-watch.ts";
import { SeatEfficiencyStore } from "./seat-efficiency.ts";
import { readSeatCommitBaseline } from "./seat-telemetry.ts";
import { type OperatorFleetSeat } from "@clankie/protocol";
import { SettingsStore, type ClankieSettings } from "@clankie/settings";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { SavedAgentSession } from "../agent-sessions.ts";
import { savedSessionHarness } from "../agent-sessions.ts";
import { type HerdrFleet } from "../herdr-fleet.ts";
import { AutonomyStore } from "./autonomy.ts";
import { type CaptainOptions } from "./captain-types.ts";
import { assertConversationAuthority, captureConversationAuthority } from "./conversation-owner.ts";
import { ConversationStore } from "./conversations.ts";
import type { CaptainDeps } from "./deps.ts";
import { DesktopExpressions } from "./desktop.ts";
import { type FleetRoomRecord } from "./fleet-room.ts";
import { FleetChangeClock } from "./herdr-fleet-changes.ts";
import { HerdrWatchStore } from "./herdr-watch.ts";
import { hireDisplayName } from "./hire-name.ts";
import { savedSessionFleet } from "./native-session-resume.ts";
import { PersonaStore, type PersonaRoleWrite } from "./personas.ts";
import type { HireSeat } from "./port.ts";
import type { HerdrWatchRunner } from "./herdr-watch.ts";

/**
 * Every assignment carries the one work-tracking contract (ADR 0191), so a
 * hire tracks work in the repo's own convention the same way he does.
 */
const WORKER_RESULT_BRIEF =
  "End each finished turn with a report in the resolved reporting style that the lead can act on without your transcript: the outcome, links to its evidence, unresolved gaps, and any decision still open.";

export interface HiringContext {
  readonly options: CaptainOptions;
  readonly deps: CaptainDeps;
  readonly settings: () => Promise<ClankieSettings>;
  readonly settingsStore: SettingsStore;
  readonly resolveHireProject: (
    input: Pick<Parameters<ProjectHirePolicy["project"]>[0], "workingDirectory" | "fleet" | "projectId">,
    projects: Parameters<ProjectHirePolicy["project"]>[1],
    authority?: Parameters<ProjectHirePolicy["project"]>[2],
  ) => Promise<string | undefined>;
  readonly autonomy: AutonomyStore;
  readonly refreshFleets: () => Promise<readonly HerdrFleet[]>;
  readonly herdrRunner: HerdrWatchRunner;
  readonly herdrWatches: HerdrWatchStore;
  readonly personas: PersonaStore;
  readonly seatEfficiency: SeatEfficiencyStore;
  readonly conversations: ConversationStore;
  readonly seatByPersona: Map<string, string>;
  readonly desktop: DesktopExpressions;
  readonly recordLeadVisit: (seatId: string, kind: "message" | "close", text?: string) => void;
  readonly noteFleetRoom: (record: FleetRoomRecord) => void;
  readonly leadParty: (conversationId: string) => FleetRoomParty;
  readonly workerParty: (seatId: string) => FleetRoomParty;
  readonly fleetChanges: FleetChangeClock;
  /** Read at call time: the captain replaces the linked fleets as they change (ADR 0325). */
  readonly namedLocal: ReadonlyArray<{ id: string; session: string; socketPath?: string | undefined }>;
  readonly remoteFleets: readonly HerdrFleet[];
  /** Read and written at call time: the captain's live seat state (ADR 0325). */
  liveSeats: readonly OperatorFleetSeat[];
}

/**
 * Hiring: start queues, hire admission and in-place starts behind one
 * `hireSeat` (moved from the captain, ADR 0325).
 */
export function createHiring(ctx: HiringContext) {
  const {
    options,
    deps,
    settings,
    settingsStore,
    resolveHireProject,
    autonomy,
    refreshFleets,
    herdrRunner,
    herdrWatches,
    personas,
    seatEfficiency,
    conversations,
    seatByPersona,
    desktop,
    recordLeadVisit,
    noteFleetRoom,
    leadParty,
    workerParty,
    fleetChanges,
  } = ctx;

  const hireWorktrees = new HireWorktrees(join(options.stateDir, "hire-worktrees.json"));
  // Hires from one start folder queue through checkout preparation; one that relocates keeps
  // its place until it returns, so an overlapping attempt sees its launch fenced (ADR 0306).
  const startQueues = new Map<string, Promise<void>>();
  // Hires admitted in their start folder itself and not yet returned, by scope: until their
  // allocation or receipt exists, these keep an overlapping attempt from relocating.
  const inPlaceStarts = new Map<string, number>();
  const queueStart = async (scope: string) => {
    const previous = startQueues.get(scope) ?? Promise.resolve();
    let release!: () => void;
    const tail = previous.then(() => new Promise<void>((resolve) => (release = resolve)));
    startQueues.set(scope, tail);
    await previous;
    return () => {
      release();
      if (startQueues.get(scope) === tail) startQueues.delete(scope);
    };
  };
  const hireSeat: HireSeat = async (request, brief, source, autonomous) => {
    const place: { release?: () => void; inPlace?: string } = {};
    try {
      return await admitHire(request, brief, source, autonomous, place);
    } finally {
      place.release?.();
      if (place.inPlace !== undefined) {
        const remaining = (inPlaceStarts.get(place.inPlace) ?? 1) - 1;
        if (remaining > 0) inPlaceStarts.set(place.inPlace, remaining);
        else inPlaceStarts.delete(place.inPlace);
      }
    }
  };
  const admitHire = async (
    request: Parameters<HireSeat>[0],
    brief: Parameters<HireSeat>[1],
    source: Parameters<HireSeat>[2],
    autonomous: Parameters<HireSeat>[3],
    place: { release?: () => void; inPlace?: string },
  ): ReturnType<HireSeat> => {
    const taskBrief = brief !== undefined;
    // The room shows the lead's own brief, not the preferences appended below.
    const leadBrief = brief;
    const captured = captureConversationAuthority(source);
    // Retain the original route proof and reread owner policy at every native
    // admission boundary, including after asynchronous checkout preparation.
    const authority =
      autonomous === true
        ? autoHireAuthority(captured, async () => {
            const current = await settings();
            const projectId = await resolveHireProject(request, current.projects, captured);
            return {
              autonomy: current.autonomy,
              project: current.projects.projects.find((entry) => entry.id === projectId),
              enabled: autonomy.enabled,
            };
          })
        : captured;
    await assertConversationAuthority(authority);
    await refreshFleets();
    if (request.freshIntent && brief === undefined)
      return { outcome: "failed", reason: "not_ready", detail: "freshIntent requires an explicit new brief" };
    if (
      brief !== undefined &&
      (!brief.trim() || brief.includes("\0") || Buffer.byteLength(brief) > 32 * 1024)
    )
      return {
        outcome: "failed",
        reason: "not_ready",
        detail: "brief must be 1 to 32768 UTF-8 bytes with no NUL",
      };
    let resume: SavedAgentSession | undefined;
    if (request.resume !== undefined) {
      try {
        if (deps.agentSessions?.resolve === undefined)
          throw new Error("Saved-session resolution is unavailable");
        resume = await deps.agentSessions.resolve(request.resume);
        if (
          (request.harness !== undefined && request.harness !== savedSessionHarness(resume)) ||
          request.workingDirectory !== resume.workingDirectory
        )
          throw new Error("Harness and workingDirectory must match the saved transcript");
        const fleet = savedSessionFleet(resume, request.fleet, await refreshFleets(), ctx.namedLocal);
        request = { ...request, ...(fleet === undefined ? {} : { fleet }) };
      } catch (error) {
        return {
          outcome: "failed",
          reason: "not_ready",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
    // A read-only hire only looks around (ADR 0320): its folder is never fetched,
    // fast-forwarded or moved to a worktree, so the owner's home stays as it is.
    if (resume === undefined && request.readOnly !== true) {
      const remote = ctx.remoteFleets.find((fleet) => fleet.id === request.fleet);
      const shell = remote && deps.fleets?.shell?.(remote);
      const paneDirectories = async () => {
        if (!herdrRunner.list) throw Error("Live checkout census unavailable");
        const panes = await herdrRunner.list(request.fleet === "default" ? undefined : request.fleet);
        return [
          ...new Set(
            panes.flatMap((pane) => {
              if (!pane.workingDirectory) throw Error("Live pane checkout is unknown");
              return [
                pane.workingDirectory,
                ...(pane.foregroundWorkingDirectory ? [pane.foregroundWorkingDirectory] : []),
              ];
            }),
          ),
        ];
      };
      const managedRuntime = async (root: string) => {
        for (const managed of await managedWorktreePaths({ runtimeRoot: options.repoRoot })) {
          if (projectPathContains(managed, root, "posix") || projectPathContains(root, managed, "posix"))
            return "Start checkout is a managed runtime; preserve its pinned HEAD";
        }
        return undefined;
      };
      const assertInactive = async (root: string) => {
        const managed = await managedRuntime(root);
        if (managed) throw Error(managed);
        for (const directory of await paneDirectories()) {
          if (projectPathContains(root, await realpath(directory), "posix"))
            throw Error("Start checkout belongs to a live pane; preserve its HEAD");
        }
      };
      // A retry of a launch that is still unresolved returns to the worktree its first attempt
      // made, so the allocation and receipt checks below see it (ADR 0207, ADR 0306).
      const scope = hireWorktreeScope(request);
      place.release = await queueStart(scope);
      let prior: HireWorktreeRelocation | undefined;
      try {
        prior = hireWorktrees.get(scope);
      } catch (error) {
        return {
          outcome: "failed",
          reason: "not_ready",
          detail: `Earlier hire worktrees are unreadable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const retained =
        prior !== undefined &&
        herdrWatches.hireRetained({ fleet: request.fleet, workingDirectory: prior.workingDirectory })
          ? prior
          : undefined;
      // A launch still fenced, or still being admitted, in the start folder itself is checked
      // there the old way, never moved, so its retry meets that folder's own allocation and
      // receipt (ADR 0207). A launch under another harness is never this one's retry.
      const admitting = retained === undefined && (inPlaceStarts.get(scope) ?? 0) > 0;
      const fenced =
        retained === undefined &&
        !admitting &&
        herdrWatches.hireRetained({
          fleet: request.fleet,
          workingDirectory: request.workingDirectory,
          harness: request.harness,
        });
      const inPlace = admitting || fenced;
      // Canonicalize remote cwd aliases on that machine, never against Mac paths.
      // allow-swallowed-rejection -- moved unchanged from the captain (ADR 0325); a hire step that can't be read leaves the hire to its own fence.
      const remoteDirectories = remote ? await paneDirectories().catch(() => null) : null;
      const freshness: HireCheckoutFreshness = retained
        ? { ...retained, outcome: "worktree", head: retained.remoteMain }
        : remote
          ? shell
            ? await verifyRemoteHireCheckout(
                remote,
                shell,
                request.workingDirectory,
                remoteDirectories,
                inPlace ? undefined : request.title,
              )
            : {
                outcome: "refused" as const,
                path: request.workingDirectory,
                reason: "Remote checkout observer unavailable",
              }
          : await verifyHireCheckout(
              request.workingDirectory,
              assertInactive,
              inPlace ? undefined : { name: request.title, refuse: managedRuntime },
            );
      if (freshness.outcome !== "worktree") {
        inPlaceStarts.set(scope, (inPlaceStarts.get(scope) ?? 0) + 1);
        place.inPlace = scope;
        place.release();
        delete place.release;
      }
      if (freshness.outcome === "refused")
        return {
          outcome: "failed",
          reason: "not_ready",
          detail: [
            freshness.reason ?? "Checkout freshness unverified",
            // Say why no fresh worktree was offered, so the caller doesn't chase the checkout.
            fenced
              ? `This start was not moved to a fresh worktree because an earlier ${request.harness ?? "agent"} start in this folder is still unresolved; it keeps the folder until its pane is closed or the earlier start is recovered.`
              : admitting
                ? "This start was not moved to a fresh worktree because another start in this folder is still being admitted; try again once it finishes."
                : undefined,
          ]
            .filter(Boolean)
            .join(". "),
        };
      if (freshness.outcome === "fresh")
        brief = [
          brief,
          `Start checkout verified against fetched origin/main: HEAD ${freshness.head}, origin/main ${freshness.remoteMain}. Keep new work based on current origin/main.`,
        ]
          .filter(Boolean)
          .join("\n\n");
      if (freshness.outcome === "worktree") {
        // The start checkout keeps its own work; the hire runs in the new worktree.
        if (!retained)
          hireWorktrees.record(
            scope,
            {
              workingDirectory: freshness.workingDirectory ?? freshness.path,
              path: freshness.path,
              branch: freshness.branch ?? "",
              start: freshness.start ?? request.workingDirectory,
              startReason: freshness.startReason ?? "",
              remoteMain: freshness.remoteMain ?? "",
              at: new Date().toISOString(),
            },
            (fleet, entry) => herdrWatches.hireRetained({ fleet, workingDirectory: entry.workingDirectory }),
          );
        request = { ...request, workingDirectory: freshness.workingDirectory ?? freshness.path };
        brief = [
          brief,
          `Your start checkout ${freshness.start} was left exactly as it was (${freshness.startReason}). You are in a new worktree at ${freshness.path}, on branch ${freshness.branch}, made from fetched origin/main ${freshness.remoteMain}. Work and commit here.`,
        ]
          .filter(Boolean)
          .join("\n\n");
      }
    }
    if (request.harness === "claude" && ctx.namedLocal.some((entry) => entry.id === request.fleet))
      return {
        outcome: "failed",
        reason: "harness_unavailable",
        detail: "Claude structured control is not configured for this named local workspace",
        control: {
          mode: "unavailable",
          reason: "unsupported_harness",
          detail: "Claude worker channel requires an exact workspace binding",
        },
      };
    try {
      const current = await settings();
      const projectId = await resolveHireProject(request, current.projects, authority);
      const project = current.projects.projects.find((entry) => entry.id === projectId);
      const policy = effectiveFleetAutonomy(current.autonomy, project?.autonomy);
      brief = [
        ...(brief === undefined ? [] : [brief]),
        "Working preferences for this assignment:",
        ...formatFleetAutonomyGuidance(policy),
        "These are standing work preferences, not tool, account or machine authority. Existing authentication, payment, credential and explicitly authorized eval boundaries still apply. Do not run evals as part of release checks without explicit owner authorization.",
        WORKER_RESULT_BRIEF,
      ].join("\n\n");
      if (brief.includes("\0") || Buffer.byteLength(brief) > 32 * 1024)
        throw new Error("brief including working preferences must be 1 to 32768 UTF-8 bytes with no NUL");
    } catch (error) {
      return {
        outcome: "failed",
        reason: "not_ready",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    request = { ...request, title: hireDisplayName(request.title) };
    await personas.ready(settingsStore);
    await personas.prepareRoleAdoption(request.role);
    let adopted: ReturnType<typeof personas.adoptSpawn> | undefined;
    let adoptedRoleWrite: PersonaRoleWrite | undefined;
    // Capture before the native harness can change its branch. A resumed or
    // legacy seat without this proof starts at first observation, never at an
    // arbitrary recent commit from its cwd.
    const commitBaseline =
      request.fleet === undefined ? await readSeatCommitBaseline(request.workingDirectory) : undefined;
    const result = await herdrWatches.spawnSeat(
      request,
      undefined,
      brief,
      resume,
      authority,
      (spawned, projectId) => {
        // Runs synchronously behind the final authority check, before the native
        // receipt is cleared. A revoked/replaced origin keeps its uncertain claim.
        if (!authority.current()) throw new Error("Hiring conversation was replaced before adoption");
        const title = resume === undefined ? request.title : hireDisplayName(spawned.seat.title);
        const seat = personas.adoptSpawn(
          spawned.seat,
          title,
          request.role,
          (status) => {
            adoptedRoleWrite = status;
          },
          projectId,
        );
        seatEfficiency.assign(seat.occupantId, {
          owner: authority.owner,
          ...(commitBaseline === undefined ? {} : { commitBaseline }),
          ...(request.deliverable === undefined ? {} : { deliverable: request.deliverable }),
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.effort === undefined ? {} : { effort: request.effort }),
        });
        conversations.bindPersona(seat.personaId, seat.seatId, seat.title);
        ctx.liveSeats = [...ctx.liveSeats.filter((current) => current.personaId !== seat.personaId), seat];
        seatByPersona.set(seat.personaId, seat.seatId);
        seat.conversationId = conversations.conversationIdForPersona(seat.personaId);
        adopted = seat;
      },
      () => personas.flushProjectRoles(),
      taskBrief,
    );
    if (result.outcome !== "spawned") return result;
    if (adopted === undefined) throw new Error("Hired seat was not finalized under its admitted authority");
    // A watch probes project settings immediately. Finish our own role write
    // before publishing the hire, so it cannot revoke the admitted controller.
    herdrWatches.trackSeat(adopted.seatId);
    if (resume === undefined) desktop.recordHire();
    if (
      brief &&
      result.deliveryStage !== "stored" &&
      (result.control?.mode === "adapter" || result.control?.mode === "channel")
    )
      recordLeadVisit(adopted.seatId, "message", brief);
    if (leadBrief !== undefined && result.deliveryStage !== undefined)
      noteFleetRoom({
        id: `hire:${adopted.seatId}:${adopted.occupantId}`,
        at: new Date().toISOString(),
        kind: "lead_message",
        from: leadParty(authority.owner.conversationId),
        to: workerParty(adopted.seatId),
        text: leadBrief,
        thread: { conversationId: authority.owner.conversationId },
        delivery: { stage: result.deliveryStage },
      });
    fleetChanges.touch();
    const roleAssignment =
      adoptedRoleWrite?.outcome === "pending"
        ? personas.roleWritePending(adoptedRoleWrite.operationId)
          ? adoptedRoleWrite
          : undefined
        : adoptedRoleWrite;
    return { ...result, seat: adopted, ...(roleAssignment ? { roleAssignment } : {}) };
  };

  return { hireSeat };
}
