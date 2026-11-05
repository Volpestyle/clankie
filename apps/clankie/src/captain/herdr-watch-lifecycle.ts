import type { SeatExitGuard } from "@clankie/agent-hosts";
import { ProjectHireProcessProofSchema } from "./project-hires.ts";
import type { RetirementGuard } from "./retirement-guard.ts";
import { assertConversationAuthority } from "./conversation-owner.ts";
import { adoptedOccupant } from "./delivery-fence.ts";
import { nativeSessionId } from "./native-session-resume.ts";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { occupantIdForHerdrSession } from "./herdr-census.ts";
import { splitFleetQualified } from "../herdr-fleet.ts";
import {
  type HerdrAgentSnapshot,
  type SpawnOperatorSeat,
  SPAWN_SESSION_WAIT_MS,
  SPAWN_SESSION_POLL_MS,
  type HerdrSeatMoveResult,
} from "./herdr-watch-types.ts";
import {
  reasonDetail,
  settleOriginalFirst,
  delay,
  ownerKeyFleet,
  originalPane,
} from "./herdr-watch-helpers.ts";
import type { HerdrWatchContext } from "./herdr-watch-context.ts";

type Context = Pick<
  HerdrWatchContext,
  | "activeHires"
  | "activeProjectHires"
  | "closeSeat"
  | "closed"
  | "fleetResources"
  | "hireOwners"
  | "hireReceipts"
  | "projectHires"
  | "projectPolicy"
  | "remoteHireReceipts"
  | "remoteWorkspace"
  | "requireWorkerAccess"
  | "restoredRetirementGuard"
  | "retireCompletedHires"
  | "runner"
  | "seatControl"
  | "spawnSeat"
  | "state"
  | "stateUnreadable"
  | "untrackSeat"
  | "validateOwner"
>;

export function createHerdrWatchLifecycle(ctx: Context) {
  /** Pane names and adopted ownership alone cannot authorize tidy. */
  function tidyProvenance(agent: HerdrAgentSnapshot) {
    if (!agent.session) return "unknown" as const;
    const occupant = occupantIdForHerdrSession(agent.session);
    const sessionId = nativeSessionId(agent);
    if (!sessionId) return "unknown" as const;
    const record = ctx.hireOwners.tidyRecord(
      agent.paneId,
      agent.terminalId,
      occupant,
      JSON.stringify([ownerKeyFleet(agent.paneId), agent.agent, sessionId]),
    );
    if (record === "unknown") return "unknown" as const;
    if (!record) return "owner_interactive" as const;
    if (record.hired === false) return "owner_interactive" as const;
    const launch = ctx.projectHires.retirementCandidate(
      splitFleetQualified(agent.paneId)?.fleet ?? "default",
      agent.paneId,
    );
    const originalLaunch =
      launch?.proof !== undefined && launch.seat === agent.terminalId && launch.occupantId === occupant;
    if (record.hired !== true && !ctx.projectHires.hiredOccupant(occupant) && !originalLaunch)
      return "unknown" as const;
    return record.owner;
  }

  /**
   * Herdr restore preserves a native session but creates a new terminal and process.
   * Recover retirement authority from the exact completed hire, or the exact occupant an
   * operator adopted by its receipt (#578), never from a title, directory, ownership
   * adoption or today's project assignment. Original journals stay intact.
   */
  async function restoredRetirementGuard(agent: HerdrAgentSnapshot): Promise<RetirementGuard> {
    const fleet = splitFleetQualified(agent.paneId)?.fleet;
    const sessionId = nativeSessionId(agent);
    if (!fleet || !agent.session || !sessionId || !ctx.runner.list || !ctx.remoteHireReceipts)
      throw new Error("Restored retirement requires complete native and original host evidence");
    const occupant = occupantIdForHerdrSession(agent.session);
    const sessionKey = JSON.stringify([fleet, agent.agent, sessionId]);
    const owner = ctx.hireOwners.restoredRetirementRecord(
      agent.paneId,
      agent.terminalId,
      occupant,
      sessionKey,
    );
    if (!owner || owner.hired !== true || owner.paneId !== agent.paneId || !owner.seatId)
      throw new Error("Restored retirement requires the persisted exact hiring owner");
    const candidate = ctx.projectHires.retirementCandidate(fleet, agent.paneId);
    if (candidate && (!candidate.confirmed || candidate.occupantId !== occupant))
      throw new Error("Restored retirement cannot replace an unconfirmed or different original hire");
    const originals = ctx.hireReceipts.all().filter(([, receipt]) => {
      if (receipt.retired || receipt.remoteAdmission?.target.fleet !== fleet) return false;
      if (receipt.completed)
        return (
          receipt.paneId === agent.paneId &&
          receipt.sessionId === sessionId &&
          receipt.occupantId === occupant
        );
      // An operator adoption (#578) names the exact terminal and session the host attested.
      const adopted = adoptedOccupant(receipt);
      return (
        adopted?.paneId === agent.paneId &&
        adopted.terminalId === agent.terminalId &&
        adopted.sessionId === agent.session!.value &&
        (receipt.paneId ?? agent.paneId) === agent.paneId &&
        (receipt.sessionId ?? sessionId) === sessionId &&
        (receipt.occupantId ?? occupant) === occupant
      );
    });
    if (originals.length !== 1) throw new Error("Completed original hire is missing or ambiguous");
    const [key, receipt] = originals[0]!;
    // Completed ordinary hires live under completed-hire:<id>, not their launch key.
    const originalKey = receipt.freshHire?.baseKey ?? receipt.hireBaseKey ?? key;
    const scope: unknown = JSON.parse(originalKey);
    const target = receipt.remoteAdmission!.target;
    if (
      !Array.isArray(scope) ||
      scope[0] !== fleet ||
      scope[1] !== agent.agent ||
      typeof scope[2] !== "string"
    )
      throw new Error("Original hire launch scope is incomplete");
    const directory = (value: string) =>
      target.shell === "powershell"
        ? win32
            .normalize(value)
            .toLowerCase()
            .replace(/[\\/]+$/u, "")
        : value;
    if (!agent.workingDirectory || directory(agent.workingDirectory) !== directory(scope[2]))
      throw new Error("Restored hire directory changed");
    const unchanged = () => {
      if (ctx.closed || ctx.activeHires.has(key) || (candidate && ctx.activeProjectHires.has(candidate.id)))
        throw new Error("Original hire is active or service closed");
      if (
        !isDeepStrictEqual(ctx.projectHires.retirementCandidate(fleet, agent.paneId), candidate) ||
        !isDeepStrictEqual(
          ctx.hireOwners.restoredRetirementRecord(agent.paneId, agent.terminalId, occupant, sessionKey),
          owner,
        ) ||
        !isDeepStrictEqual(ctx.hireReceipts.all().find(([id]) => id === key)?.[1], receipt)
      )
        throw new Error("Original retirement provenance changed");
    };
    const host = async () => {
      const claim = await ctx.remoteHireReceipts!.claim(fleet, {
        receiptId: receipt.messageId,
        receiptKey: originalKey,
        fingerprint: receipt.fingerprint,
      });
      if (!claim || !isDeepStrictEqual(claim.target, target))
        throw new Error("Original remote hire target changed or disconnected");
    };
    const census = async () => {
      const inventory = await ctx.runner.list!(fleet);
      const matching = inventory.filter(
        (item) =>
          item.paneId === agent.paneId ||
          item.terminalId === agent.terminalId ||
          ((item.agent === agent.agent || item.session?.source === agent.session!.source) &&
            nativeSessionId(item) === sessionId),
      );
      const current = matching[0];
      if (
        matching.length !== 1 ||
        !current?.session ||
        current.paneId !== agent.paneId ||
        current.terminalId !== agent.terminalId ||
        current.agent !== agent.agent ||
        occupantIdForHerdrSession(current.session) !== occupant ||
        !current.workingDirectory ||
        directory(current.workingDirectory) !== directory(agent.workingDirectory!)
      )
        throw new Error("Restored hire census is absent, changed or ambiguous");
      if (!["idle", "done"].includes(current.status)) throw new Error("Restored hire is not idle");
      return inventory;
    };
    const observe = async () => {
      unchanged();
      await host();
      const inventory = await census();
      const observed = await ctx.projectPolicy?.proof?.(fleet, agent.paneId);
      const proof =
        observed &&
        ProjectHireProcessProofSchema.parse({
          nativeOccupantId: observed.nativeOccupantId,
          fleet: observed.fleet,
          pane: observed.pane,
          binding: observed.binding,
          processes: observed.processes,
          shell: observed.shell,
        });
      if (
        !proof ||
        proof.nativeOccupantId !== occupant ||
        proof.fleet !== fleet ||
        proof.pane !== agent.paneId ||
        proof.binding.session !== target.session ||
        (candidate?.proof && !isDeepStrictEqual(proof.binding, candidate.proof.binding))
      )
        throw new Error("Restored hire native process or connection is unavailable or changed");
      await census();
      await host();
      unchanged();
      return { proof, inventory };
    };
    const original = await observe();
    const verify: RetirementGuard = async () => {
      const latest = await observe();
      if (!isDeepStrictEqual(latest.proof, original.proof))
        throw new Error("Restored native process changed during retirement");
    };
    verify.restoredHire = {
      receiptId: receipt.messageId,
      originalSeatId: candidate?.seat ?? owner.seatId,
      target,
      observedAt: new Date().toISOString(),
      censusSha256: createHash("sha256").update(JSON.stringify(original.inventory)).digest("hex"),
      proof: original.proof,
    };
    return verify;
  }

  /** Captured once before retirement. Unconfirmed launches retain their original process proof. */
  async function retirementGuard(agent: HerdrAgentSnapshot): Promise<RetirementGuard> {
    const fleet = splitFleetQualified(agent.paneId)?.fleet ?? "default";
    const candidate = ctx.projectHires.retirementCandidate(fleet, agent.paneId);
    if (
      splitFleetQualified(agent.paneId) &&
      (!candidate || !candidate.proof || candidate.seat !== agent.terminalId)
    )
      return ctx.restoredRetirementGuard(agent);
    const check = async () => {
      if (ctx.closed) throw new Error("Native hire service is closed");
      if (!candidate) {
        if (splitFleetQualified(agent.paneId))
          throw new Error("Remote retirement requires original launch proof");
        return;
      }
      if (ctx.activeProjectHires.has(candidate.id)) throw new Error("Original hire is still active");
      if (
        !candidate.proof ||
        candidate.seat !== agent.terminalId ||
        !agent.session ||
        candidate.occupantId !== occupantIdForHerdrSession(agent.session)
      )
        throw new Error("Original hire identity is unavailable or changed");
      if (
        JSON.stringify(ctx.projectHires.retirementCandidate(fleet, agent.paneId)) !==
        JSON.stringify(candidate)
      )
        throw new Error("Original project allocation changed");
      // Independent of confirmation: an unsettled original for this occupant (or an unreadable
      // journal) always holds retirement until it is settled, e.g. by settle_hire_receipt adopt.
      const unsettled = ctx.hireReceipts
        .all()
        .filter(
          ([, receipt]) =>
            receipt.paneId === agent.paneId &&
            receipt.occupantId === candidate.occupantId &&
            !receipt.completed &&
            !receipt.settlement &&
            !receipt.abandoned,
        );
      if (unsettled.length)
        throw new Error(settleOriginalFirst(unsettled.map(([, receipt]) => receipt.messageId)));
      const proof = await ctx.projectPolicy?.proof?.(fleet, agent.paneId);
      if (ctx.projectHires.assignment(fleet, agent.paneId, proof).state !== "assigned")
        throw new Error("Original native process or connection changed");
      if (!candidate.confirmed) {
        const original = ctx.hireReceipts
          .all()
          .filter(([, receipt]) =>
            candidate.request.freshIntent
              ? receipt.freshHire?.id === candidate.request.freshIntent.id
              : receipt.paneId === agent.paneId && receipt.occupantId === candidate.occupantId,
          );
        if (original.length !== 1 || !original[0]![1].settlement)
          throw new Error(settleOriginalFirst(original.map(([, receipt]) => receipt.messageId)));
      }
    };
    await check();
    return check;
  }

  /** Read-only capability preflight. Missing native exit cannot create a
   * close_unconfirmed journal when no exit could ever have been attempted. */
  async function nativeExitAvailable(agent: HerdrAgentSnapshot): Promise<boolean> {
    if (ctx.closed) return false;
    try {
      const control = await ctx.seatControl.attach(agent);
      if (!control?.verify || !control.exit || control.ref.paneId !== agent.paneId) return false;
      await control.verify();
      return true;
    } catch {
      return false;
    }
  }

  async function closeSeat(seatId: string, guard?: SeatExitGuard, nativeOnly = false): Promise<boolean> {
    if (ctx.closed || ctx.runner.closePane === undefined) return false;
    try {
      const current = await ctx.runner.resolveTerminal(seatId);
      if (current === undefined) return false;
      const resourceOwner = await ctx.fleetResources?.proveSimulatorSeat({ seatId }).catch(() => undefined);
      const noteVerifiedExit = () => {
        if (resourceOwner)
          void ctx.fleetResources?.observeVerifiedSeatExit(resourceOwner).catch(() => undefined);
      };
      const fleet = splitFleetQualified(current.paneId)?.fleet;
      const candidates = ctx.projectHires.inventoryCandidates(fleet ?? "default");
      const confirmGone = async () => {
        const completedHire =
          fleet !== undefined &&
          ctx.hireReceipts
            .all()
            .some(
              ([, receipt]) =>
                !receipt.retired &&
                originalPane(receipt) === current.paneId &&
                receipt.remoteAdmission?.target.fleet === fleet,
            );
        // Unmanaged closes have neither project allocations nor authenticated hire receipts to retire.
        if (candidates.size === 0 && !completedHire) return true;
        if (!ctx.runner.list) return false;
        const inventory = await ctx.runner.list(fleet);
        if (
          inventory.some((pane) => pane.paneId === current.paneId || pane.terminalId === current.terminalId)
        )
          return false;
        ctx.projectHires.reconcile(
          fleet ?? "default",
          new Set(inventory.map((pane) => pane.paneId)),
          ctx.activeProjectHires,
          candidates,
        );
        // The pane has exited and its allocation is now gone. Its live admission
        // guard is no longer meaningful here; retirement has its own complete
        // census and unchanged-host fence. A bookkeeping failure stays unconfirmed.
        if (fleet) await ctx.retireCompletedHires(fleet, { paneId: current.paneId });
        return true;
      };
      // pane.close has no lifetime condition. A prepared native TUI can exit
      // itself through its original process-bound controller; Herdr removes
      // its command pane on process exit. Never fall back to physical close.
      if (
        nativeOnly ||
        ctx.state.preparedPanes?.some(
          (entry) =>
            entry.paneId === current.paneId ||
            entry.terminalId === seatId ||
            entry.terminalId === current.terminalId,
        )
      ) {
        const control = await ctx.seatControl.attach(current);
        if (!control?.verify || !control.exit) return false;
        await control.verify();
        await guard?.();
        // A lost reply may follow the native exit. Observe; do not retry.
        await control.exit(guard).catch(() => undefined);
        const deadline = Date.now() + SPAWN_SESSION_WAIT_MS;
        do {
          if ((await ctx.runner.resolveTerminal(seatId)) === undefined) {
            await control.close().catch(() => undefined);
            if (!(await confirmGone())) return false;
            noteVerifiedExit();
            return true;
          }
          await delay(SPAWN_SESSION_POLL_MS);
        } while (Date.now() < deadline);
        return false;
      }
      if (ctx.stateUnreadable && (current.agent === "opencode" || current.agent === "pi")) return false;
      // Controller disposal can stop the dedicated native backend. Keep it
      // alive through every admission check so a refusal has no close effects.
      const control = await ctx.seatControl.attach(current);
      await guard?.();
      if (guard) await ctx.runner.closePane(current.paneId, guard);
      else await ctx.runner.closePane(current.paneId);
      // The manager independently checks this original process tuple. A pane
      // close reply alone cannot reclaim a still-live or replaced occupant.
      if (!(await confirmGone())) return false;
      await control?.close().catch(() => undefined);
      noteVerifiedExit();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send a seat to another working directory (ADR 0166).
   *
   * A process cannot be moved: its directory is fixed when it is executed. So
   * the seat is closed and hired again where it is going, under the same agent
   * name — which is the persona's binding key, so the character, its thread,
   * and everything hanging off them come with it. The chair is new; the worker
   * in it is not.
   *
   * The old pane closes first. A hire that then fails leaves the seat gone
   * rather than duplicated, which is the failure the operator can see and act
   * on; a second live pane wearing the same name is one they cannot.
   */
  async function moveSeat(input: {
    readonly seatId: string;
    readonly subject: string;
    readonly harness: SpawnOperatorSeat["harness"];
    readonly title: SpawnOperatorSeat["title"];
    readonly role?: SpawnOperatorSeat["role"];
    readonly workingDirectory: string;
  }): Promise<HerdrSeatMoveResult> {
    if (ctx.closed) return { outcome: "failed", reason: "herdr_unreachable" };
    const fleet = splitFleetQualified(input.seatId)?.fleet;
    try {
      await ctx.requireWorkerAccess?.(fleet);
    } catch (error) {
      return { outcome: "failed", reason: "not_ready", detail: reasonDetail(error) };
    }
    if (fleet === undefined && !existsSync(input.workingDirectory)) {
      return { outcome: "failed", reason: "unknown_directory", detail: input.workingDirectory };
    }
    if (
      fleet !== undefined &&
      !(await ctx.remoteWorkspace?.(fleet, input.workingDirectory).catch(() => false))
    ) {
      return { outcome: "failed", reason: "unknown_directory", detail: input.workingDirectory };
    }
    const current = await ctx.runner.resolveTerminal(input.seatId);
    const owner =
      current?.session === undefined
        ? undefined
        : ctx.hireOwners.owner(current.paneId, input.seatId, occupantIdForHerdrSession(current.session));
    if (owner === undefined)
      return {
        outcome: "failed",
        reason: "not_ready",
        detail: "Moving a worker requires its exact persisted native owner",
      };
    const authority = {
      owner,
      current: () => !ctx.closed,
      authorize: async () => (await ctx.validateOwner?.(owner)) === true,
    };
    if (authority !== undefined) await assertConversationAuthority(authority);
    const guard = async () => {
      await assertConversationAuthority(authority);
      await ctx.requireWorkerAccess?.(fleet);
      const latest = await ctx.runner.resolveTerminal(input.seatId);
      if (
        latest?.session === undefined ||
        latest.paneId !== current!.paneId ||
        ctx.hireOwners.owner(latest.paneId, latest.terminalId, occupantIdForHerdrSession(latest.session))
          ?.conversationId !== owner.conversationId
      )
        throw new Error("The moved worker native identity changed");
      await assertConversationAuthority(authority);
    };
    if (!(await ctx.closeSeat(input.seatId, guard))) {
      return { outcome: "failed", reason: "herdr_unreachable", detail: input.seatId };
    }
    ctx.untrackSeat(input.seatId);
    const result = await ctx.spawnSeat(
      {
        schemaVersion: 1,
        harness: input.harness,
        title: input.title,
        ...(input.role === undefined ? {} : { role: input.role }),
        // A move names a destination, not a shared pipeline enrollment.
        placement: "new-tab",
        workingDirectory: input.workingDirectory,
        ...(fleet === undefined ? {} : { fleet }),
      },
      input.subject,
      undefined,
      undefined,
      authority,
    );
    // A move re-hires under the seat's own name, which is never counted against
    // capacity; the guard only keeps the result within the move contract.
    if (result.outcome === "spawned") return result;
    const { reason, ...rest } = result;
    return {
      ...rest,
      reason:
        reason === "at_capacity"
          ? "herdr_unreachable"
          : reason === "delivery_unconfirmed" || reason === "start_unconfirmed"
            ? "not_ready"
            : reason,
    };
  }
  return {
    tidyProvenance,
    restoredRetirementGuard,
    retirementGuard,
    nativeExitAvailable,
    closeSeat,
    moveSeat,
  };
}
