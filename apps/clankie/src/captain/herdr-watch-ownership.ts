import {
  settleAttemptByMerge,
  type AttemptCandidate,
  type AttemptLaunch,
  type AttemptMerge,
  type AttemptSettlement,
  type ProjectHireProcessProof,
} from "./project-hires.ts";
import { type HireStarter } from "./hire-owners.ts";
import {
  captureConversationAuthority,
  assertConversationAuthority,
  type ConversationAuthority,
  type ConversationOwner,
} from "./conversation-owner.ts";
import { DeliveryFence } from "./delivery-fence.ts";
import { nativeSessionId } from "./native-session-resume.ts";
import { redactSensitiveText } from "@clankie/observability";
import { type OperatorFleetSeat } from "@clankie/protocol";
import { occupantIdForHerdrSession, type ObservedFleetSeat } from "./herdr-census.ts";
import { nativeProofLocation, splitFleetQualified } from "../herdr-fleet.ts";
import {
  type HerdrAgentSnapshot,
  type SpawnOperatorSeat,
  type HireAuthority,
  UNRECORDED_HIRE_SETTLE_MS,
  SPAWN_SESSION_POLL_MS,
  SEAT_PICKUP_WAIT_MS,
} from "./herdr-watch-types.ts";
import { unattributedSeat, projectHirePane, bounded, delay, ownerKeyFleet } from "./herdr-watch-helpers.ts";
import type { HerdrWatchContext } from "./herdr-watch-context.ts";

type Context = Pick<
  HerdrWatchContext,
  | "closed"
  | "controllers"
  | "githubOrigin"
  | "hireAttempt"
  | "hireOwners"
  | "hireReceipts"
  | "launchHeld"
  | "legacyProjectHire"
  | "nativeOwner"
  | "nativeSessionKey"
  | "onReadopted"
  | "piSeatModel"
  | "projectContexts"
  | "projectHireProof"
  | "projectHires"
  | "requireWorkerAccess"
  | "retireReboundWatches"
  | "runner"
  | "save"
  | "seatClaim"
  | "seatControl"
  | "seatWithSession"
  | "state"
  | "stateUnreadable"
  | "validateOwner"
  | "watchHiredSeat"
>;

export function createHerdrWatchOwnership(ctx: Context) {
  /** Reuse native attachment/queue capability; bridge display cards grant nothing. */
  async function nativeRouteAvailable(agent: HerdrAgentSnapshot): Promise<boolean> {
    if (ctx.closed || !agent.session) return false;
    const control = await ctx.seatControl.attach(agent);
    const status = await control?.status().catch(() => undefined);
    if (status === "idle" || status === "working" || status === "blocked") return true;
    // Unowned Codex sessions already have a native queue path (ADR 0185/0207).
    return (
      agent.agent === "codex" &&
      (splitFleetQualified(agent.paneId) !== undefined || ctx.runner.codexQueue !== undefined)
    );
  }

  /** Native waiting detail is display metadata; census identity and authority stay unchanged. */
  async function refreshWorkerCatalog(
    paneId: string,
    input: { revision: string; beforeDispatch?: () => Promise<void> },
  ): Promise<{ outcome: "refreshed" | "skipped-busy" | "failed"; reason: string }> {
    const original = await ctx.runner.get(paneId);
    if (ctx.closed || !original?.session)
      return { outcome: "failed", reason: "original_native_session_unavailable" };
    const identity = JSON.stringify([original.terminalId, original.agent, original.session]);
    const current = async () => {
      await input.beforeDispatch?.();
      await ctx.requireWorkerAccess?.(splitFleetQualified(original.paneId)?.fleet);
      const fresh = await ctx.runner.get(paneId);
      if (ctx.closed || !fresh || JSON.stringify([fresh.terminalId, fresh.agent, fresh.session]) !== identity)
        throw new Error("Original native session changed");
    };
    const control = await ctx.seatControl.attach(original);
    if (!control?.refreshToolCatalog)
      return { outcome: "failed", reason: "original_native_catalog_refresh_unavailable" };
    await current();
    return control.refreshToolCatalog({ revision: input.revision, beforeDispatch: current });
  }

  async function withNativeStatus(
    seats: readonly OperatorFleetSeat[],
    observed: readonly ObservedFleetSeat[],
  ): Promise<readonly OperatorFleetSeat[]> {
    const byId = new Map(observed.map((seat) => [seat.seatId, seat]));
    return Promise.all(
      seats.map(async (seat) => {
        const source = byId.get(seat.seatId);
        if (ctx.closed || source === undefined) return seat;
        const failure = ctx.hireOwners.startupFailure(
          source.paneId,
          source.seatId,
          source.session === undefined ? undefined : occupantIdForHerdrSession(source.session),
        );
        if (failure) seat = { ...seat, summary: bounded(failure, 1000) };
        const control = await ctx.seatControl.attach({
          terminalId: source.seatId,
          paneId: source.paneId,
          agent: source.harness,
          status: source.status,
          title: source.title,
          ...(source.session === undefined ? {} : { session: source.session }),
        });
        if (control === undefined) return seat;
        const [status, reason, stopped] = await Promise.all([
          control.status().catch(() => undefined),
          control.statusReason?.().catch(() => undefined),
          // allow-swallowed-rejection -- an unreadable stop reason leaves the seat's own status shown.
          control.stopped?.().catch(() => undefined),
        ]);
        // Its runtime ended; the view left in the pane can still look busy.
        if (stopped !== undefined)
          return { ...seat, status: "stopped", summary: bounded(failure ?? stopped, 1_000) };
        return {
          ...seat,
          // Native idle proves quiescence, not that a completed worker became unfinished.
          ...(status === "idle" || status === "working" || status === "blocked"
            ? { status: status === "idle" && source.status === "done" ? "done" : status }
            : {}),
          ...(reason === undefined || failure
            ? {}
            : { summary: bounded(redactSensitiveText(reason), 1_000) }),
        };
      }),
    );
  }

  /** Only fresh host-observed native proof selects a worker's leading conversation. */
  function nativeOwner(agent: HerdrAgentSnapshot): ConversationOwner | undefined {
    const owner =
      agent.session === undefined
        ? undefined
        : ctx.hireOwners.owner(agent.paneId, agent.terminalId, occupantIdForHerdrSession(agent.session));
    if (owner === undefined && ctx.hireOwners.hasClaim(agent.paneId, agent.terminalId))
      throw new Error("The worker native occupant no longer matches its persisted owner");
    return owner;
  }

  function reportLeads(agent: HerdrAgentSnapshot) {
    ctx.nativeOwner(agent);
    return agent.session === undefined
      ? []
      : ctx.hireOwners.reportLeads(agent.paneId, agent.terminalId, occupantIdForHerdrSession(agent.session));
  }

  function grantReportLead(agent: HerdrAgentSnapshot, lead: import("./hire-owners.ts").HireReportLead): void {
    ctx.nativeOwner(agent);
    if (!agent.session) throw new Error("Report grants require a native occupant");
    ctx.hireOwners.grantReportLead(
      agent.paneId,
      agent.terminalId,
      occupantIdForHerdrSession(agent.session),
      lead,
    );
  }

  function revokeReportLead(agent: HerdrAgentSnapshot, id: string): void {
    ctx.nativeOwner(agent);
    if (!agent.session) throw new Error("Report grants require a native occupant");
    ctx.hireOwners.revokeReportLead(
      agent.paneId,
      agent.terminalId,
      occupantIdForHerdrSession(agent.session),
      id,
    );
  }

  /** Who asked for this exact occupant's hire (ADR 0321); display only. */
  /** Whether Clankie recorded hiring this seat with this native session (#584). */
  function hiredSession(seatId: string, harness: string, sessionId: string): boolean {
    return ctx.hireOwners.hiredSession(seatId, JSON.stringify([ownerKeyFleet(seatId), harness, sessionId]));
  }

  function seatStarter(seatId: string, occupantId: string): HireStarter | undefined {
    return ctx.hireOwners.starter(seatId, occupantId);
  }

  /** The lead a hire on this seat or pane named for report wakes (#735). */
  function notifyLead(seatId: string | undefined, paneId: string): string | undefined {
    return ctx.hireOwners.notifyLead(seatId, paneId);
  }

  /** Whether a seat holds a finished hire, for a start receipt that outlived its service (#735). */
  function hiredSeat(seatId: string): boolean {
    return ctx.hireOwners.hiredSeat(seatId);
  }

  /** Whether this connector device hired this exact occupant and still leads it (#442). */
  function connectorLeads(seatId: string, occupantId: string, deviceId: string): boolean {
    return ctx.hireOwners.appLead(seatId, occupantId, deviceId);
  }

  /** Whether a pane holds a Clankie hire, for fleet-health alert attribution only (#324). */
  function paneHire(paneId: string, requireProvenance = false): "starting" | "hired" | undefined {
    return ctx.hireOwners.paneHire(paneId, requireProvenance);
  }

  /** Read-only provenance for holding a verified worker report while re-adoption is required. */
  function retainedReportOwner(agent: HerdrAgentSnapshot): ConversationOwner | undefined {
    const sessionKey = ctx.nativeSessionKey(agent);
    return sessionKey === undefined
      ? undefined
      : ctx.hireOwners.retainedReportOwner(agent.paneId, agent.terminalId, sessionKey);
  }

  /** Persist adoption before native delivery so an immediate report sees its new lead. */
  /**
   * Make this conversation the seat's lead before it messages the seat. A live
   * hire another conversation leads keeps that lead (VUH-1763): the message
   * still goes, and the result names the lead so reports keep returning there.
   */
  async function adoptSeat(
    seatId: string,
    source: ConversationAuthority,
  ): Promise<{ adopted: true } | { adopted: false; ownerConversationId: string }> {
    const authority = captureConversationAuthority(source);
    if (ctx.closed || ctx.stateUnreadable) throw new Error("Native ownership service is unavailable");
    await assertConversationAuthority(authority);
    const agent = await ctx.seatWithSession(() => ctx.runner.resolveTerminal(seatId));
    if (ctx.closed || ctx.stateUnreadable) throw new Error("Native ownership service is unavailable");
    unattributedSeat(seatId, agent);
    ctx.nativeOwner(agent);
    // Another lead may message a seat Clankie hired, but does not take it over
    // (VUH-1763). A hire whose lead conversation no longer exists is adopted, so
    // it is never stranded; hand-started seats are adopted as before.
    const claim = ctx.seatClaim(agent);
    if (
      claim?.hired === true &&
      claim.owner.conversationId !== authority.owner.conversationId &&
      (ctx.validateOwner === undefined || (await ctx.validateOwner(claim.owner)))
    )
      return { adopted: false, ownerConversationId: claim.owner.conversationId };
    await assertConversationAuthority(authority);
    const latest = await ctx.runner.resolveTerminal(seatId);
    if (
      latest?.session === undefined ||
      latest.paneId !== agent.paneId ||
      latest.terminalId !== seatId ||
      latest.agent !== agent.agent ||
      occupantIdForHerdrSession(latest.session) !== occupantIdForHerdrSession(agent.session)
    )
      throw new Error("The adopted native occupant changed during admission");
    await assertConversationAuthority(authority);
    const sessionId = nativeSessionId(latest);
    ctx.hireOwners.adopt(
      latest.paneId,
      latest.terminalId,
      occupantIdForHerdrSession(latest.session),
      authority.owner,
      sessionId === undefined
        ? undefined
        : JSON.stringify([ownerKeyFleet(latest.paneId), latest.agent, sessionId]),
    );
    return { adopted: true };
  }

  /** Repair a legitimate reattachment only under the thread's existing owning conversation. */
  async function readoptSeat(seatId: string, source: ConversationAuthority): Promise<void> {
    const authority = captureConversationAuthority(source);
    if (ctx.closed || ctx.stateUnreadable) throw new Error("Native ownership service is unavailable");
    await assertConversationAuthority(authority);
    const agent = await ctx.seatWithSession(() => ctx.runner.resolveTerminal(seatId));
    if (ctx.closed || ctx.stateUnreadable) throw new Error("Native ownership service is unavailable");
    unattributedSeat(seatId, agent);
    if (agent.status === "offline" || agent.status === "unknown")
      throw new Error(
        `The agent in seat ${seatId} is ${agent.status}, so its session can't be re-adopted now; read it, and re-adopt once it is running.`,
      );
    const sessionKey = ctx.nativeSessionKey(agent);
    if (sessionKey === undefined) throw new Error("Exact native thread identity is unavailable");
    const held = ctx.hireOwners.sessionOwner(sessionKey);
    if (held === undefined || held.conversationId !== authority.owner.conversationId)
      throw new Error("Saved session has no matching persisted hiring conversation");
    if (ctx.validateOwner !== undefined && !(await ctx.validateOwner(held)))
      throw new Error("Persisted hiring conversation authority is unavailable");
    await assertConversationAuthority(authority);
    const latest = await ctx.runner.resolveTerminal(seatId);
    if (
      latest?.session === undefined ||
      latest.paneId !== agent.paneId ||
      latest.terminalId !== seatId ||
      latest.agent !== agent.agent ||
      latest.status === "offline" ||
      latest.status === "unknown" ||
      ctx.nativeSessionKey(latest) !== sessionKey ||
      occupantIdForHerdrSession(latest.session) !== occupantIdForHerdrSession(agent.session)
    )
      throw new Error("The reattached native occupant changed during admission");
    await assertConversationAuthority(authority);
    const rebound = ctx.hireOwners.readopt(
      latest.paneId,
      latest.terminalId,
      occupantIdForHerdrSession(latest.session),
      authority.owner,
      sessionKey,
    );
    ctx.retireReboundWatches(rebound.replaced, latest);
    ctx.watchHiredSeat(latest.terminalId, occupantIdForHerdrSession(latest.session), rebound.owner);
    ctx.onReadopted?.({
      occupantId: occupantIdForHerdrSession(latest.session),
      title: latest.title,
      harness: latest.agent,
      ...(latest.name === undefined ? {} : { name: latest.name }),
    });
  }

  function nativeSessionKey(agent: HerdrAgentSnapshot): string | undefined {
    const sessionId = nativeSessionId(agent);
    return sessionId === undefined
      ? undefined
      : JSON.stringify([ownerKeyFleet(agent.paneId), agent.agent, sessionId]);
  }

  function retireReboundWatches(
    replaced: readonly { seatId?: string | undefined; occupantId?: string | undefined }[],
    current: HerdrAgentSnapshot,
  ): void {
    const occupantId = occupantIdForHerdrSession(current.session!);
    const retired = ctx.state.watches.filter(
      (watch) =>
        watch.hired === true &&
        (watch.terminalId !== current.terminalId || watch.occupantId !== occupantId) &&
        replaced.some((entry) => entry.seatId === watch.terminalId && entry.occupantId === watch.occupantId),
    );
    if (retired.length === 0) return;
    const retiredIds = new Set(retired.map((watch) => watch.id));
    ctx.state.watches = ctx.state.watches.filter((watch) => !retiredIds.has(watch.id));
    for (const watch of retired) ctx.controllers.get(watch.id)?.abort();
    ctx.save();
  }

  async function bindHireOwner(
    agent: HerdrAgentSnapshot,
    input: SpawnOperatorSeat,
    authority: HireAuthority,
  ): Promise<void> {
    const occupantId = occupantIdForHerdrSession(agent.session!);
    const sessionId = nativeSessionId(agent);
    const sessionKey =
      sessionId === undefined
        ? undefined
        : JSON.stringify([input.fleet ?? "local", input.harness, sessionId]);
    if (authority.resumedSessionKey !== undefined) {
      if (sessionKey !== authority.resumedSessionKey)
        throw new Error("The resumed worker reported a different native thread; ownership was not rebound");
      await assertConversationAuthority(authority);
      const latest = await ctx.runner.resolveTerminal(agent.terminalId);
      if (
        latest?.session === undefined ||
        latest.paneId !== agent.paneId ||
        latest.terminalId !== agent.terminalId ||
        latest.agent !== input.harness ||
        latest.status === "offline" ||
        latest.status === "unknown" ||
        ctx.nativeSessionKey(latest) !== authority.resumedSessionKey ||
        occupantIdForHerdrSession(latest.session) !== occupantId
      )
        throw new Error("The resumed native occupant changed before ownership was rebound");
      await assertConversationAuthority(authority);
      const rebound = ctx.hireOwners.readopt(
        agent.paneId,
        agent.terminalId,
        occupantId,
        authority.owner,
        authority.resumedSessionKey,
        authority.intentId,
      );
      ctx.retireReboundWatches(rebound.replaced, agent);
    } else
      ctx.hireOwners.bind(
        agent.paneId,
        authority.owner,
        agent.terminalId,
        authority.intentId,
        occupantId,
        sessionKey,
        ctx.projectContexts.get(input)?.projectId ?? input.projectId,
      );
  }

  /** Why a hire's own runtime ended under its still-open pane; undefined while it runs. */
  async function stoppedReason(agent: HerdrAgentSnapshot): Promise<string | undefined> {
    // allow-swallowed-rejection -- an unreadable stop reason only omits the read note; the pane is still read.
    return (await ctx.seatControl.attach(agent))?.stopped?.().catch(() => undefined);
  }

  /** The herdr status an adapter-held seat's own status reads as; undefined when no adapter holds it. */
  async function adapterStatus(agent: HerdrAgentSnapshot): Promise<string | undefined> {
    const status = await (await ctx.seatControl.attach(agent))?.status().catch(() => undefined);
    return status === "working" || status === "idle" || status === "blocked" ? status : undefined;
  }

  /**
   * The seat's status once a message has had a moment to start a turn: an idle
   * seat right after delivery would read as already settled to `herdr_watch`.
   * Returns the last status seen when the wait runs out.
   */
  async function awaitPickup(seatId: string, timeoutMs = SEAT_PICKUP_WAIT_MS): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let status = "unknown";
    while (!ctx.closed) {
      status = (await ctx.runner.resolveTerminal(seatId).catch(() => undefined))?.status ?? "offline";
      if (status !== "idle" || Date.now() >= deadline) return status;
      await delay(SPAWN_SESSION_POLL_MS);
    }
    return status;
  }

  /**
   * Hire an agent (ADR 0013): a tab in the chosen directory, a harness started
   * in it, and the seat it became. Every failure is an outcome rather than a
   * throw — the surface renders "couldn't hire" and keeps the operator's draft.
   *
   * A start that fails leaves no stray tab behind: the pane opened for it is
   * closed on the way out, so a retry does not accumulate empty shells.
   */
  /**
   * Hire a seat. `subject` is the herdr agent name, which is also the key the
   * persona binding hangs on — a move passes the old one so the character
   * comes with it instead of a stranger arriving in the new district.
   */
  /**
   * The model a pi seat starts on. A hosted body on included usage runs every
   * pi worker on its own included model, whatever was asked, since no other
   * provider has a key there; a `clankie/…` alias that was asked for stays. On
   * the customer's own credential the worker defaults to their model.
   * Elsewhere pi keeps its own configuration.
   */
  async function hostedPiModel(requested: string | undefined): Promise<string | undefined> {
    const hosted = await ctx.piSeatModel?.();
    if (hosted === undefined) return requested;
    if (hosted.provider === undefined) return requested ?? hosted.model;
    await ctx.runner.configurePiProvider?.(hosted.provider.id, hosted.provider.config);
    return requested?.startsWith(`${hosted.provider.id}/`) === true ? requested : hosted.model;
  }

  function leadHireMembershipOwner(pane: string, seat: string, occupant: string) {
    return ctx.hireOwners.hiredProjectContext(pane, seat, occupant);
  }

  /**
   * Like `hireRetained`, but a settled original no longer counts: only a launch that may still
   * be running unconfirmed (#614). A folder whose hire settled takes new work elsewhere; its
   * original key stays fenced against replay. With a harness, only that harness's launches count.
   */
  function hireUnresolved(input: {
    readonly fleet?: string | undefined;
    readonly workingDirectory: string;
    readonly harness?: string | undefined;
  }): boolean {
    return ctx.launchHeld(input, (key) => ctx.hireReceipts.pending(key) !== undefined);
  }

  /**
   * Whether a new launch into this folder is still unresolved or was settled by recovery. A retry
   * of that launch must arrive at the same folder (ADR 0207, ADR 0306). With a harness, only that
   * harness's launches count: a launch under another harness is never this one's retry, so it
   * doesn't pin a new start to the folder.
   */
  function hireRetained(input: {
    readonly fleet?: string | undefined;
    readonly workingDirectory: string;
    readonly harness?: string | undefined;
  }): boolean {
    return ctx.launchHeld(
      input,
      (key) => ctx.hireReceipts.pending(key) !== undefined || ctx.hireReceipts.settled(key) !== undefined,
    );
  }

  /**
   * Whether this exact lead brief already started a hire in this folder that recovery then
   * settled (#730). Resending it is a possible duplicate, so it is refused rather than moved
   * to a fresh worktree. Receipts from before the lead fingerprint was kept never match.
   */
  function hireResent(input: {
    readonly fleet?: string | undefined;
    readonly workingDirectory: string;
    readonly harness?: string | undefined;
    readonly leadFingerprint: string;
  }): boolean {
    return ctx.launchHeld(
      input,
      (key) => ctx.hireReceipts.settled(key)?.leadFingerprint === input.leadFingerprint,
      false,
    );
  }

  function launchHeld(
    input: {
      readonly fleet?: string | undefined;
      readonly workingDirectory: string;
      readonly harness?: string | undefined;
    },
    held: (key: string) => boolean,
    conservative = true,
  ): boolean {
    if (conservative && ctx.projectHires.unresolved(input)) return true;
    let receipts: ReturnType<DeliveryFence["all"]>;
    try {
      receipts = ctx.hireReceipts.all();
    } catch {
      return conservative;
    }
    return receipts.some(([key]) => {
      let parts: unknown;
      try {
        parts = JSON.parse(key);
      } catch {
        return false;
      }
      if (!Array.isArray(parts)) return false;
      const [fleet, harness, workingDirectory, session] = parts as unknown[];
      return (
        fleet === (input.fleet ?? "local") &&
        (input.harness === undefined || harness === input.harness) &&
        workingDirectory === input.workingDirectory &&
        session === "new" &&
        held(key)
      );
    });
  }

  /** The title this seat was hired under, from Clankie's own hire ledger (LOCAL-VUH-59). */
  function hireTitle(seat: { readonly paneId: string; readonly occupantId: string }): string | undefined {
    const fleet = nativeProofLocation(seat.paneId).fleet;
    return ctx.projectHires.hireTitle(fleet, projectHirePane(fleet, seat.paneId), seat.occupantId);
  }

  /** Whether this seat is a deliberate attempt at its deliverable, and whether it was superseded (#602). */
  function hireAttempt(seat: { readonly paneId: string }) {
    const fleet = nativeProofLocation(seat.paneId).fleet;
    return ctx.projectHires.attempt(fleet, projectHirePane(fleet, seat.paneId));
  }

  /** Original allocation evidence for the exact currently observed native occupant. */
  function missingWorktreeClaim(agent: HerdrAgentSnapshot) {
    if (!agent.session) return undefined;
    const location = nativeProofLocation(agent.paneId);
    return ctx.projectHires.missingWorktreeClaim(
      location.fleet,
      location.pane,
      agent.terminalId,
      occupantIdForHerdrSession(agent.session),
    );
  }

  /**
   * The exact attempt allocation this pane's current occupant holds, captured before a
   * close releases it (#602). Undefined unless the ledger's occupant is this session.
   */
  function hireAttemptRecord(
    agent: HerdrAgentSnapshot,
  ): { readonly allocation: string; readonly occupantId: string } | undefined {
    const attempt = ctx.hireAttempt(agent);
    if (attempt?.occupantId === undefined || !agent.session) return undefined;
    return occupantIdForHerdrSession(agent.session) === attempt.occupantId
      ? { allocation: attempt.allocation, occupantId: attempt.occupantId }
      : undefined;
  }

  /**
   * Settle the captured attempt's deliverable from each attempt's launch record and the
   * pull request GitHub merged from its hire branch (#602); see settleAttemptByMerge.
   */
  function settleHireAttempt(
    record: { readonly allocation: string; readonly occupantId: string },
    launchOf: (candidate: AttemptCandidate) => AttemptLaunch | undefined,
    mergedPull: (repository: string, launch: AttemptLaunch) => Promise<AttemptMerge | undefined>,
  ): Promise<AttemptSettlement | undefined> {
    return settleAttemptByMerge(ctx.projectHires, record, launchOf, mergedPull);
  }

  /**
   * The project a seat's current occupant was hired into, and the GitHub repository of the
   * checkout it was hired in, from the hire ledger; display only.
   */
  function hiredProject(
    seatId: string,
    occupantId: string,
  ): { readonly projectId: string; readonly repository?: string } | undefined {
    const hire = ctx.projectHires.hiredInto(seatId, occupantId);
    if (hire === undefined) return undefined;
    const repository = ctx.githubOrigin(hire.workingDirectory);
    return { projectId: hire.projectId, ...(repository === undefined ? {} : { repository }) };
  }

  function projectHireMembershipCandidate(fleet: string, pane: string) {
    const address = projectHirePane(fleet, pane);
    if (address === undefined) return { state: "none" as const };
    const candidate = ctx.projectHires.membershipCandidate(fleet, address);
    return candidate.state === "none" && ctx.legacyProjectHire(fleet, address)
      ? { state: "unconfirmed" as const }
      : candidate;
  }

  /** Retained exit bookkeeping only; the caller first proves the original native assignment. */
  function projectHireBookkeepingAttribution(fleet: string, pane: string, occupantId: string) {
    const address = projectHirePane(fleet, pane);
    return address === undefined
      ? undefined
      : ctx.projectHires.bookkeepingAttribution(fleet, address, occupantId);
  }

  function confirmedProjectHireAssignment(
    fleet: string,
    pane: string,
    revision: string,
    proof: ProjectHireProcessProof,
  ) {
    const address = projectHirePane(fleet, pane);
    const current = address === undefined ? undefined : ctx.projectHireProof(fleet, address, proof);
    return address === undefined || current === undefined
      ? { state: "invalid" as const }
      : ctx.projectHires.confirmedAssignment(fleet, address, revision, current);
  }

  function projectHireAssignment(fleet: string, pane: string, proof?: ProjectHireProcessProof) {
    const address = projectHirePane(fleet, pane);
    if (address === undefined) return { state: "invalid" as const };
    const assignment = ctx.projectHires.assignment(
      fleet,
      address,
      ctx.projectHireProof(fleet, address, proof),
    );
    return assignment.state === "none" && ctx.legacyProjectHire(fleet, address)
      ? { state: "invalid" as const }
      : assignment;
  }

  /** A legacy bare allocation is still a hire, never an owner-started workspace fallback. */
  function legacyProjectHire(fleet: string, pane: string) {
    const qualified = splitFleetQualified(pane);
    return (
      qualified !== undefined && ctx.projectHires.membershipCandidate(fleet, qualified.id).state !== "none"
    );
  }

  function projectHireProof(fleet: string, pane: string, proof?: ProjectHireProcessProof) {
    if (proof?.fleet !== fleet || projectHirePane(fleet, proof.pane) !== pane) return undefined;
    return { ...proof, pane };
  }

  /** Describe the original blocker and existing operator recovery commands; never changes it. */
  function projectHireBlocker(id: string): string {
    const allocation = ctx.projectHires.allocation(id);
    const request = allocation?.request;
    const baseKey =
      request === undefined
        ? undefined
        : JSON.stringify([request.fleet ?? "local", request.harness, request.workingDirectory, "new"]);
    const receipts = ctx.hireReceipts.all().filter(([key, record]) => {
      if (request?.freshIntent !== undefined) return record.freshHire?.id === request.freshIntent.id;
      if (baseKey === undefined) return false;
      return (
        (record.freshHire?.baseKey ?? record.hireBaseKey ?? key) === baseKey &&
        (allocation?.pane === undefined || record.paneId === allocation.pane)
      );
    });
    const receipt = receipts.length === 1 ? receipts[0]![1] : undefined;
    const receiptId = receipt?.messageId;
    return `${ctx.projectHires.describe(id)}; native receipt ${receiptId ?? "not recorded"}. ${allocation?.pane === undefined ? `Its pane never appeared; it settles itself once ${UNRECORDED_HIRE_SETTLE_MS / 60_000} minutes old if no agent runs in its directory. ` : ""}Owner: inspect the original agent; if it is gone, run \`clankie hire-receipt settle ${receiptId ?? id} abandoned\`, then \`clankie hire-receipt settle ${id} release-allocation\``;
  }
  return {
    nativeRouteAvailable,
    refreshWorkerCatalog,
    withNativeStatus,
    nativeOwner,
    reportLeads,
    grantReportLead,
    revokeReportLead,
    hiredSession,
    seatStarter,
    notifyLead,
    hiredSeat,
    connectorLeads,
    paneHire,
    retainedReportOwner,
    adoptSeat,
    readoptSeat,
    nativeSessionKey,
    retireReboundWatches,
    bindHireOwner,
    stoppedReason,
    adapterStatus,
    awaitPickup,
    hostedPiModel,
    leadHireMembershipOwner,
    hireUnresolved,
    hireRetained,
    hireResent,
    launchHeld,
    hireTitle,
    hireAttempt,
    missingWorktreeClaim,
    hireAttemptRecord,
    settleHireAttempt,
    hiredProject,
    projectHireMembershipCandidate,
    projectHireBookkeepingAttribution,
    confirmedProjectHireAssignment,
    projectHireAssignment,
    legacyProjectHire,
    projectHireProof,
    projectHireBlocker,
  };
}
