import { ProjectHires } from "./project-hires.ts";
import { type ConversationOwner } from "./conversation-owner.ts";
import { type UncertainReceipt } from "./delivery-fence.ts";
import { HERDR_CORE_FLEET } from "./herdr-core-runner.ts";
import { nativeSessionId } from "./native-session-resume.ts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { OPERATOR_CONVERSATION_SUMMARY_MAX } from "@clankie/protocol";
import { occupantIdForHerdrSession } from "./herdr-census.ts";
import { splitFleetQualified } from "../herdr-fleet.ts";
import type {
  HireReceiptSettlement,
  HireRecoveryEvidence,
  LocalHireSettlementEvidence,
} from "@clankie/protocol";
import { type HerdrAgentSnapshot, UNRECORDED_HIRE_SETTLE_MS } from "./herdr-watch-types.ts";
import {
  reasonDetail,
  projectHirePane,
  ownerKeyFleet,
  thisMachineReceiptFleet,
  originalPane,
  agentInDirectory,
} from "./herdr-watch-helpers.ts";
import type { HerdrWatchContext } from "./herdr-watch-context.ts";

type Context = Pick<
  HerdrWatchContext,
  | "abandonLocalHireReceipt"
  | "activeHires"
  | "activeProjectHires"
  | "adoptLocalHire"
  | "adoptRemoteHire"
  | "channelReceipt"
  | "closed"
  | "hireOwners"
  | "hireReceipts"
  | "loadedAt"
  | "localHireReceipt"
  | "projectHires"
  | "projectPolicy"
  | "recoverHireReceipt"
  | "releaseSettledHireAllocation"
  | "remoteAdoption"
  | "remoteClaim"
  | "remoteHireReceipts"
  | "retireGoneLocalHires"
  | "retireUnsentRemoteHires"
  | "runner"
  | "settleNativeHireReceipt"
  | "shellOnlyPane"
  | "unrecordedHireStale"
  | "watchHiredSeat"
>;

export function createHerdrWatchRecovery(ctx: Context) {
  async function retireCompletedHires(
    fleet: string,
    scope: { baseKey?: string; paneId?: string },
    guard?: () => Promise<void>,
  ): Promise<void> {
    const candidates = ctx.hireReceipts
      .all()
      .filter(
        ([key, receipt]) =>
          originalPane(receipt) !== undefined &&
          !receipt.retired &&
          receipt.remoteAdmission?.target.fleet === fleet &&
          (scope.baseKey === undefined ||
            (receipt.freshHire?.baseKey ?? receipt.hireBaseKey ?? key) === scope.baseKey) &&
          (scope.paneId === undefined || originalPane(receipt) === scope.paneId),
      );
    if (!candidates.length) return;
    if (!ctx.runner.list || !ctx.remoteHireReceipts)
      throw new Error(
        "Complete native inventory and original host target are required for completed hire retirement",
      );
    const observed = new Set<string>();
    for (const [key, receipt] of candidates) {
      const target = receipt.remoteAdmission!.target;
      const identity = JSON.stringify(target);
      if (observed.has(identity)) continue;
      const lookup = () =>
        ctx.remoteHireReceipts!.claim(fleet, {
          receiptId: receipt.messageId,
          receiptKey: key,
          fingerprint: receipt.fingerprint,
        });
      const before = await lookup();
      if (!before || !isDeepStrictEqual(before.target, target))
        throw new Error("The completed original's remote host target changed or disconnected");
      const inventory = await ctx.runner.list(fleet);
      const after = await lookup();
      await guard?.();
      if (ctx.closed || !after || !isDeepStrictEqual(after.target, target))
        throw new Error("Original host target changed during completed hire census");
      ctx.hireReceipts.retireCompleted(
        target,
        new Set(inventory.map((agent) => agent.paneId)),
        ctx.activeHires,
      );
      observed.add(identity);
    }
  }

  /** Resolve a fresh intent to its native fence; only its live owner or the operator may settle. */
  async function settleHireReceipt(
    receiptId: string,
    guard?: () => Promise<void>,
    disposition:
      | "not-launched"
      | "delivered"
      | "abandoned"
      | "abandoned-unknown"
      | "release-allocation"
      | "adopt" = "not-launched",
    owner?: ConversationOwner,
  ): Promise<HireReceiptSettlement> {
    const refused = (detail: string): HireReceiptSettlement => ({ state: "refused", receiptId, detail });
    if (!guard) return refused("Settlement authority is required; nothing settled.");
    if (disposition === "adopt")
      return owner
        ? refused("Only the operator may adopt an unconfirmed hire; nothing adopted.")
        : ctx.remoteAdoption(receiptId)
          ? ctx.adoptRemoteHire(receiptId, guard)
          : ctx.adoptLocalHire(receiptId, guard);
    try {
      await guard();
      const matches = ctx.hireReceipts
        .all()
        .filter(([, record]) => record.messageId === receiptId || record.freshHire?.id === receiptId);
      if (matches.length > 1) return refused("Hire identity is ambiguous; nothing settled.");
      const record = matches[0]?.[1];
      const projectAllocation = ctx.projectHires.recoveryCandidate(receiptId);
      // Old failed starts omitted their native UUID. Resolve the retained
      // allocation to exactly one local original; never infer a replacement.
      if (projectAllocation && disposition === "abandoned" && !owner) {
        const originals = ctx.hireReceipts.entries().filter(([key, original]) => {
          const [fleet, harness, cwd] = JSON.parse(key) as string[];
          return (
            thisMachineReceiptFleet(fleet) &&
            fleet === (projectAllocation.request.fleet ?? "local") &&
            harness === projectAllocation.request.harness &&
            cwd === projectAllocation.request.workingDirectory &&
            original.paneId === projectAllocation.pane &&
            !original.freshHire &&
            !original.remoteAdmission
          );
        });
        if (originals.length !== 1)
          return refused("Allocation has no unique unresolved local native receipt; nothing settled.");
        return ctx.settleNativeHireReceipt(originals[0]![1].messageId, guard, "abandoned");
      }
      if (projectAllocation && disposition !== "release-allocation")
        return refused(
          `Project allocation ${receiptId} is not a native hire receipt. The operator may use release-allocation after settling any original native receipt and proving complete pane-absent inventory; abandoned-unknown cannot describe a project-only claim.`,
        );
      if (owner && (!record?.freshHire || record.freshHire.owner.conversationId !== owner.conversationId))
        return refused("Only the fresh hire's owning conversation or the operator may settle it.");
      if (record?.freshHire && (disposition === "delivered" || disposition === "release-allocation"))
        return refused("Fresh intent settlement requires not-launched, abandoned or abandoned-unknown.");
      const result = await ctx.settleNativeHireReceipt(record?.messageId ?? receiptId, guard, disposition);
      const allocation = record?.freshHire ? ctx.projectHires.retainedIntent(record.freshHire.id) : undefined;
      return {
        ...result,
        receiptId,
        ...(allocation
          ? {
              detail:
                `Allocation ${allocation.id} retains pane ${allocation.pane ?? "unobserved"}; delivery settlement does not release it. Owning lead: keep report and use close_worker_pane with reason; owner/process/draft/work checks apply. Complete pane-absent inventory releases it. ${"detail" in result ? (result.detail ?? "") : ""}`.slice(
                  0,
                  OPERATOR_CONVERSATION_SUMMARY_MAX,
                ),
            }
          : {}),
      };
    } catch (error) {
      return refused(`Settlement unavailable: ${reasonDetail(error)}. Original remains fenced.`);
    }
  }

  /** Operator recovery only. Takes identity, never caller-supplied evidence or a launch request. */
  async function settleNativeHireReceipt(
    receiptId: string,
    guard?: () => Promise<void>,
    disposition:
      | "not-launched"
      | "delivered"
      | "abandoned"
      | "abandoned-unknown"
      | "release-allocation" = "not-launched",
    expectedAllocation?: NonNullable<ReturnType<ProjectHires["recoveryCandidate"]>>,
  ): Promise<HireReceiptSettlement> {
    const refused = (detail: string): HireReceiptSettlement => ({ state: "refused", receiptId, detail });
    if (!guard) return refused("Operator settlement authority is required; nothing settled.");
    try {
      await guard();
    } catch {
      return refused("Operator settlement authority is unavailable; nothing settled.");
    }
    if (disposition === "release-allocation") {
      const candidate = ctx.projectHires.recoveryCandidate(receiptId);
      if (expectedAllocation && !isDeepStrictEqual(candidate, expectedAllocation))
        return refused("Original allocation changed before automatic retirement; nothing released.");
      const released = (): HireReceiptSettlement => ({
        state: "allocation-released",
        receiptId,
        fleet: candidate!.request.fleet ?? "local",
        workingDirectory: candidate!.request.workingDirectory,
        detail:
          "Operator released only the project allocation after a complete native inventory. Launch history remains unchanged; no pane was closed and no native receipt was replayed.",
      });
      if (candidate?.gone && candidate.operatorRelease) return released();
      if (!candidate || ctx.activeProjectHires.has(receiptId) || !ctx.runner.list)
        return refused(
          "No inactive unresolved project allocation, or complete native inventory is unavailable.",
        );
      const unresolved = () =>
        ctx.hireReceipts.entries().some(([key]) => {
          const scope = JSON.parse(key) as unknown[];
          return (
            scope[0] === (candidate.request.fleet ?? "local") &&
            scope[2] === candidate.request.workingDirectory
          );
        });
      try {
        const fleet = candidate.request.fleet ?? "default";
        const originalPane =
          candidate.pane === undefined ? undefined : projectHirePane(fleet, candidate.pane);
        if (candidate.pane !== undefined && originalPane === undefined)
          return refused("Original allocation has an invalid pane address; nothing released.");
        if (unresolved())
          return refused(
            "Settle the original native hire receipt before releasing this allocation; no receipt was replayed.",
          );
        const census = async () => {
          const inventory = await ctx.runner.list!(candidate.request.fleet);
          const present = inventory.filter(
            (agent) =>
              (originalPane !== undefined && originalPane === projectHirePane(fleet, agent.paneId)) ||
              agent.workingDirectory === candidate.request.workingDirectory,
          );
          // A local original pane that never held an observed occupant and now
          // holds only its own shell launched nothing to retire (VUH-2243).
          const shell =
            candidate.request.fleet === undefined &&
            candidate.occupantId === undefined &&
            present.length === 1 &&
            present[0]!.paneId === originalPane
              ? await ctx.shellOnlyPane(present[0]!)
              : undefined;
          const shellOnly = typeof shell === "number" ? shell : undefined;
          return { inventory, held: shellOnly === undefined && present.length > 0, shellOnly };
        };
        const before = await census();
        await guard();
        const { inventory, held, shellOnly } = await census();
        if (expectedAllocation) await guard();
        if (ctx.closed || ctx.activeProjectHires.has(receiptId) || unresolved())
          return refused(
            "Original allocation became active or acquired an unresolved native receipt; nothing released.",
          );
        if (held || before.held || before.shellOnly !== shellOnly)
          return refused(
            "The original pane or a worker in its directory is still present. Retain its handoff and retire it explicitly before releasing the allocation.",
          );
        ctx.projectHires.release(candidate, inventory, expectedAllocation?.nativeReceipt);
        return released();
      } catch (error) {
        return refused(`Allocation recovery unavailable: ${reasonDetail(error)}. Nothing released.`);
      }
    }
    const local = ctx.localHireReceipt(receiptId);
    if (local && disposition === "abandoned") return ctx.abandonLocalHireReceipt(receiptId, guard);
    if (local && disposition === "not-launched")
      return refused(
        "A local hire has no host reservation window, so it cannot prove it never launched. Settle it as abandoned from complete local inventory; nothing settled.",
      );
    if (disposition !== "not-launched") return ctx.recoverHireReceipt(receiptId, guard, disposition);
    const settled = ctx.hireReceipts.settlement(receiptId);
    if (settled)
      return settled.journal === "reserved-to-sealed-without-launch" ||
        settled.journal === "never-reserved" ||
        settled.journal === "launch-committed-command-unsent"
        ? { state: "settled-not-launched", receiptId, evidence: settled }
        : refused("Original receipt already has a different retained disposition.");
    const original = ctx.hireReceipts.entries().find(([, receipt]) => receipt.messageId === receiptId);
    if (!original) return refused("No unresolved original native hire receipt; nothing dispatched.");
    const [key, receipt] = original;
    if (ctx.activeHires.has(key)) return refused("Original hire is still active; nothing settled.");
    const claim = ctx.remoteClaim(key, receipt);
    if (
      !claim ||
      !ctx.remoteHireReceipts ||
      (receipt.remoteLaunchCommitted && !receipt.remoteCommandUnsent) ||
      receipt.paneId ||
      receipt.sessionId ||
      receipt.occupantId
    )
      return refused(
        "Original receipt lacks a complete no-launch window, or already allocated a pane/process/session. Current absence is insufficient.",
      );
    try {
      await guard();
      const evidence = await ctx.remoteHireReceipts.seal(
        claim,
        receipt.remoteCommandUnsent ? { commandUnsent: true } : undefined,
      );
      await guard();
      if (ctx.activeHires.has(key))
        return refused("Original hire became active during census; local receipt remains fenced.");
      ctx.hireReceipts.settleNotLaunched(key, receiptId, evidence);
      return { state: "settled-not-launched", receiptId, evidence };
    } catch (error) {
      return refused(
        `Authenticated host settlement unavailable: ${reasonDetail(error)}. Original receipt retained.`,
      );
    }
  }

  /** An unresolved or locally settled original with no remote host admission. */
  function localHireReceipt(receiptId: string): boolean {
    const settled = ctx.hireReceipts.settlement(receiptId);
    if (settled) return settled.journal === "local-host-inventory";
    const original = ctx.hireReceipts.entries().find(([, receipt]) => receipt.messageId === receiptId);
    return (
      original !== undefined &&
      thisMachineReceiptFleet(JSON.parse(original[0])[0]) &&
      !original[1].remoteAdmission &&
      !original[1].freshHire
    );
  }

  /**
   * Whether a present pane holds only its own shell: no harness or session
   * reported, and its shell is the only foreground process (VUH-2243).
   */
  async function shellOnlyPane(pane: HerdrAgentSnapshot): Promise<number | string> {
    if (pane.agent !== "unknown" || pane.session !== undefined)
      return `Pane ${pane.paneId} reports a ${pane.agent === "unknown" ? `${pane.session!.source} session` : pane.agent} occupant`;
    if (!ctx.runner.paneShell) return "Pane process info is unavailable";
    const shell = await ctx.runner.paneShell(pane.paneId);
    return shell.shellPid !== undefined &&
      shell.foreground.length > 0 &&
      shell.foreground.every((process) => process.pid === shell.shellPid)
      ? shell.shellPid
      : `Pane ${pane.paneId} runs a foreground process other than its shell (${shell.foreground.map((process) => process.name).join(", ") || "none observed"})`;
  }

  function unrecordedHireStale(beganAt: number | undefined): boolean {
    return Date.now() - (beganAt ?? ctx.loadedAt) >= UNRECORDED_HIRE_SETTLE_MS;
  }

  /**
   * Frees a project place in this directory whose earlier hire's agent is gone (#251):
   * settles its native receipts as {@link retireGoneLocalHires} does, then releases a
   * stale allocation whose pane never appeared through the operator's own census.
   */
  async function retireGoneProjectHires(workingDirectory: string, guard: () => Promise<void>): Promise<void> {
    for (const allocation of ctx.projectHires.unresolvedLocalAt(workingDirectory)) {
      const harness = allocation.request.harness;
      if (ctx.activeProjectHires.has(allocation.id) || allocation.request.freshIntent || !harness) continue;
      await ctx.retireGoneLocalHires(JSON.stringify(["local", harness, workingDirectory, "new"]), guard);
      const current = ctx.projectHires.allocation(allocation.id);
      if (
        !current ||
        current.gone ||
        current.confirmed ||
        current.pane !== undefined ||
        !ctx.unrecordedHireStale(current.beganAt)
      )
        continue;
      const released = await ctx.settleNativeHireReceipt(allocation.id, guard, "release-allocation");
      if (released.state === "allocation-released")
        console.warn("Released a project hire whose pane never appeared", {
          allocationId: allocation.id,
          workingDirectory,
        });
    }
  }

  /**
   * Settles each unresolved hire at this place whose agent is gone (ADR 0331): its
   * recorded pane is absent from this machine's complete inventory or holds no harness,
   * or it never recorded a pane, is a few minutes old, and no such harness runs there.
   * The same proof the operator's settlement takes; a hire still running is left as is,
   * and a refusal changes nothing. Never closes, sends or relaunches anything.
   */
  async function retireGoneLocalHires(baseKey: string, guard: () => Promise<void>): Promise<void> {
    let unresolved: readonly (readonly [string, UncertainReceipt])[];
    try {
      unresolved = ctx.hireReceipts.entries().filter(
        ([key, receipt]) =>
          (receipt.freshHire?.baseKey ?? receipt.hireBaseKey ?? key) === baseKey &&
          // A hire whose pane never appeared waits a few minutes: its launch may still draw one.
          (receipt.paneId !== undefined || ctx.unrecordedHireStale(receipt.beganAt)) &&
          !receipt.freshHire &&
          !ctx.activeHires.has(key),
      );
    } catch {
      return;
    }
    for (const [key, receipt] of unresolved) {
      if (!ctx.localHireReceipt(receipt.messageId)) continue;
      const settled = await ctx.abandonLocalHireReceipt(receipt.messageId, guard);
      if (settled.state === "abandoned")
        console.warn("Settled a hire whose agent is gone", {
          receiptId: receipt.messageId,
          place: key,
          pane: receipt.paneId ?? "none recorded",
          ...(settled.allocationId === undefined
            ? {}
            : { allocationId: settled.allocationId, allocation: settled.detail }),
        });
    }
  }

  /**
   * Retire only a remote attempt sealed as never launched. Run before checkout or
   * project-allocation fences, since those can otherwise hide the existing seal.
   * A causal receipt link and the operator's double census protect the allocation.
   */
  async function retireUnsentRemoteAt(
    input: { fleet?: string | undefined; workingDirectory: string; harness?: string | undefined },
    guard: () => Promise<void>,
    projectId?: string,
  ): Promise<void> {
    if (thisMachineReceiptFleet(input.fleet ?? "local") || ctx.closed) return;
    try {
      const matches = (key: string) => {
        const [fleet, harness, cwd, session] = JSON.parse(key) as unknown[];
        return (
          fleet === input.fleet &&
          cwd === input.workingDirectory &&
          session === "new" &&
          (input.harness === undefined || harness === input.harness)
        );
      };
      const keys = [
        ...new Set(
          ctx.hireReceipts
            .entries()
            .filter(([key]) => matches(key))
            .map(([key]) => key),
        ),
      ];
      for (const key of keys) await ctx.retireUnsentRemoteHires(key, guard);
      const candidates = ctx.projectHires.unresolvedAt(input);
      for (const candidate of candidates) {
        const receipt = candidate.nativeReceipt;
        if (
          projectId === undefined ||
          candidate.projectId !== projectId ||
          !receipt ||
          candidates.filter((entry) => isDeepStrictEqual(entry.nativeReceipt, receipt)).length !== 1 ||
          !matches(receipt.key) ||
          !isDeepStrictEqual(JSON.parse(receipt.key), [
            candidate.request.fleet ?? "local",
            candidate.request.harness,
            candidate.request.workingDirectory,
            "new",
          ]) ||
          candidate.request.freshIntent ||
          candidate.pane !== undefined ||
          candidate.seat !== undefined ||
          candidate.occupantId !== undefined ||
          candidate.proof !== undefined ||
          ctx.activeProjectHires.has(candidate.id) ||
          ctx.activeHires.has(receipt.key)
        )
          continue;
        const evidence = ctx.hireReceipts.settlement(receipt.id);
        if (
          !evidence ||
          evidence.receiptKey !== receipt.key ||
          ![
            "never-reserved",
            "reserved-to-sealed-without-launch",
            "launch-committed-command-unsent",
          ].includes(evidence.journal)
        )
          continue;
        // The expected snapshot is checked again after guard awaits, then under
        // the existing allocation lock after the complete before/after census.
        await ctx.settleNativeHireReceipt(candidate.id, guard, "release-allocation", candidate);
      }
    } catch {
      // Unreadable journals, disconnected hosts and denied authority keep the place held.
    }
  }

  /**
   * Settles each earlier hire at this place on another machine whose launch was committed
   * but whose only effect was an unanswered workspace create (#326, amending ADR 0331).
   * No harness command left this service, so the host's authenticated census decides,
   * exactly as the operator's `not-launched` does: a pane in the hire's directory (a
   * create that landed late) keeps it fenced. Never closes, sends or relaunches anything.
   */
  async function retireUnsentRemoteHires(baseKey: string, guard: () => Promise<void>): Promise<void> {
    let unsent: readonly (readonly [string, UncertainReceipt])[];
    try {
      unsent = ctx.hireReceipts
        .entries()
        .filter(
          ([key, receipt]) =>
            (receipt.hireBaseKey ?? key) === baseKey &&
            !receipt.freshHire &&
            receipt.remoteLaunchCommitted === true &&
            receipt.remoteCommandUnsent === true &&
            receipt.paneId === undefined &&
            receipt.sessionId === undefined &&
            receipt.occupantId === undefined &&
            !receipt.recoveryRequested &&
            !ctx.activeHires.has(key),
        );
    } catch {
      return;
    }
    for (const [key, receipt] of unsent) {
      const settled = await ctx.settleNativeHireReceipt(receipt.messageId, guard, "not-launched");
      if (settled.state === "settled-not-launched")
        console.warn("Settled a remote hire whose workspace create never answered", {
          receiptId: receipt.messageId,
          place: key,
        });
    }
  }

  /**
   * Operator settlement of a local hire from this machine's complete Herdr
   * inventory (VUH-2243). Settles only while no harness occupies the original
   * pane (absent, or holding nothing but its shell), then frees the location for
   * a new hire. Never closes a pane, claims launch or delivery, or replays the brief.
   */
  async function abandonLocalHireReceipt(
    receiptId: string,
    guard: () => Promise<void>,
  ): Promise<HireReceiptSettlement> {
    const refused = (detail: string): HireReceiptSettlement => ({ state: "refused", receiptId, detail });
    const settled = ctx.hireReceipts.settlement(receiptId);
    if (settled)
      return settled.journal === "local-host-inventory" && settled.disposition === "abandoned"
        ? ctx.releaseSettledHireAllocation(settled.receiptKey, settled.pane?.paneId, guard, {
            state: "abandoned",
            receiptId,
            evidence: settled,
          })
        : refused("Original receipt already has a different retained disposition.");
    const original = ctx.hireReceipts.entries().find(([, receipt]) => receipt.messageId === receiptId);
    if (!original) return refused("No unresolved original local hire receipt; nothing settled.");
    const [key, receipt] = original;
    const [fleet, harness, cwd] = JSON.parse(key) as string[];
    if (
      !thisMachineReceiptFleet(fleet) ||
      !harness ||
      !cwd ||
      receipt.remoteAdmission ||
      receipt.recoveryRequested
    )
      return refused("Original is not a local hire receipt; nothing settled.");
    // The desktop app's terminals are this machine's too (ADR 0319): its own complete
    // inventory settles them, as Herdr's does for a local pane. The recorded pane decides
    // which inventory, since a this-machine hire may have been placed in either.
    const paneFleet = receipt.paneId === undefined ? undefined : splitFleetQualified(receipt.paneId)?.fleet;
    if (paneFleet !== undefined && paneFleet !== HERDR_CORE_FLEET)
      return refused("Original pane is not on this machine; nothing settled.");
    const inventoryFleet = paneFleet ?? (fleet === "local" ? undefined : fleet);
    if (ctx.closed || ctx.activeHires.has(key))
      return refused("Original hire is still active; nothing settled.");
    if (!ctx.runner.list || !ctx.runner.paneShell)
      return refused(
        "Complete local Herdr inventory and pane process info are unavailable; nothing settled.",
      );
    ctx.activeHires.add(key);
    let abandoned: HireReceiptSettlement & { state: "abandoned" };
    try {
      const observe = async () => {
        const inventory = await ctx.runner.list!(inventoryFleet);
        if (receipt.paneId === undefined) {
          // No pane was recorded: an unrecorded launch would be a harness in this directory.
          const occupied = inventory.find(
            (pane) =>
              pane.agent === harness &&
              (pane.workingDirectory === cwd || pane.foregroundWorkingDirectory === cwd),
          );
          if (occupied)
            throw new Error(
              `${harness} pane ${occupied.paneId} runs in ${cwd} and may be this unrecorded launch`,
            );
          return { inventory, pane: undefined };
        }
        const pane = inventory.find((entry) => entry.paneId === receipt.paneId);
        if (!pane) return { inventory, pane: { paneId: receipt.paneId, present: false as const } };
        const shellPid = await ctx.shellOnlyPane(pane);
        if (typeof shellPid === "string")
          throw new Error(`${shellPid}; its hiring lead may adopt or retire it`);
        return {
          inventory,
          pane: { paneId: pane.paneId, present: true as const, terminalId: pane.terminalId, shellPid },
        };
      };
      const first = await observe();
      await guard();
      const final = await observe();
      if (!isDeepStrictEqual(first.pane, final.pane))
        throw new Error("The original pane changed during census");
      // No await follows the final observation before the durable settlement.
      if (ctx.closed) throw new Error("Native hire service is closed");
      const evidence = {
        receiptId,
        receiptKey: key,
        fingerprint: receipt.fingerprint,
        disposition: "abandoned" as const,
        journal: "local-host-inventory" as const,
        census: {
          observedAt: Date.now(),
          panes: final.inventory.length,
          sha256: createHash("sha256")
            .update(JSON.stringify(final.inventory.map((pane) => [pane.paneId, pane.terminalId]).sort()))
            .digest("hex"),
        },
        ...(final.pane === undefined ? {} : { pane: final.pane }),
      };
      ctx.hireReceipts.settleLocal(key, receiptId, evidence);
      abandoned = { state: "abandoned", receiptId, evidence };
    } catch (error) {
      return refused(
        `Local settlement refused: ${reasonDetail(error)}. Original retained; nothing sent, closed or relaunched.`,
      );
    } finally {
      ctx.activeHires.delete(key);
    }
    return ctx.releaseSettledHireAllocation(key, receipt.paneId, guard, abandoned);
  }

  /**
   * A settled local hire's own project allocation would otherwise keep refusing
   * every new hire in its place ("The earlier hire still needs checking"). Free it
   * through the operator release-allocation path, with that path's own complete
   * inventory checks: nothing in the original pane but its shell, and no worker in
   * its directory. The settlement stands whether or not the release passes.
   */
  async function releaseSettledHireAllocation(
    receiptKey: string,
    paneId: string | undefined,
    guard: () => Promise<void>,
    abandoned: HireReceiptSettlement & { state: "abandoned" },
  ): Promise<HireReceiptSettlement> {
    const [, harness, cwd] = JSON.parse(receiptKey) as string[];
    if (!harness || !cwd) return abandoned;
    const candidates = ctx.projectHires.unresolvedLocal(cwd, paneId, harness);
    if (candidates.length !== 1) return abandoned;
    const allocationId = candidates[0]!.id;
    try {
      const released = await ctx.settleNativeHireReceipt(allocationId, guard, "release-allocation");
      return {
        ...abandoned,
        allocationId,
        detail:
          released.state === "allocation-released"
            ? "Its project allocation was released too, so its place takes a new hire."
            : `Its project allocation still holds the place: ${"detail" in released ? released.detail : released.state}`.slice(
                0,
                OPERATOR_CONVERSATION_SUMMARY_MAX,
              ),
      };
    } catch (error) {
      return {
        ...abandoned,
        allocationId,
        detail: `Its project allocation still holds the place: ${reasonDetail(error)}`.slice(
          0,
          OPERATOR_CONVERSATION_SUMMARY_MAX,
        ),
      };
    }
  }

  /**
   * Operator adoption of a launched local hire that never confirmed (VUH-2243).
   * Its harness runs in the pane this hire allocated, but its occupant was never
   * bound, so its lead cannot reach it. Binds that exact host-observed occupant
   * to the conversation that hired the pane, confirms its project allocation
   * from matching process proof, and settles the original receipt. It never
   * claims the brief arrived, and never sends, replays or closes anything.
   */
  async function adoptLocalHire(id: string, guard: () => Promise<void>): Promise<HireReceiptSettlement> {
    const refused = (detail: string): HireReceiptSettlement => ({ state: "refused", receiptId: id, detail });
    let fenced: string | undefined;
    let fencedAllocation: string | undefined;
    try {
      await guard();
      if (ctx.closed || !ctx.runner.list) throw new Error("Complete local Herdr inventory is unavailable");
      const localOriginal = ([key, receipt]: readonly [string, UncertainReceipt]) =>
        thisMachineReceiptFleet(JSON.parse(key)[0]) && !receipt.remoteAdmission && !receipt.freshHire;
      let original = ctx.hireReceipts.entries().find(([, receipt]) => receipt.messageId === id);
      let allocation = ctx.projectHires.allocation(id);
      const settled = ctx.hireReceipts.settlement(id);
      if (!original && !allocation && settled) {
        if (settled.journal !== "local-host-inventory" || settled.disposition !== "adopted")
          throw new Error("Original receipt already has a different retained disposition");
        const pane = settled.pane as {
          paneId: string;
          terminalId: string;
          occupantId: string;
          sessionId?: string;
        };
        return {
          state: "adopted",
          receiptId: id,
          seat: {
            paneId: pane.paneId,
            seatId: pane.terminalId,
            occupantId: pane.occupantId,
            ...(pane.sessionId === undefined ? {} : { sessionId: pane.sessionId }),
          },
          owner: (settled.pane as { owner: { conversationId: string } }).owner,
          evidence: settled,
          detail: "Already adopted; the retained adoption is unchanged.",
        };
      }
      if (original && !localOriginal(original))
        throw new Error("Only a local hire receipt can be adopted from local inventory");
      if (original?.[1].paneId && !allocation)
        allocation = ctx.projectHires.retirementCandidate("default", original[1].paneId);
      if (allocation && !original)
        original = ctx.hireReceipts
          .entries()
          .find((entry) => localOriginal(entry) && entry[1].paneId === allocation!.pane);
      if (!original && !allocation)
        throw new Error("No unresolved local hire receipt or project allocation has this UUID");
      if (allocation && (allocation.gone || allocation.request.fleet !== undefined || !allocation.started))
        throw new Error(`Allocation ${allocation.id} is not a started local hire`);
      const receipt = original?.[1];
      const paneId = receipt?.paneId ?? allocation?.pane;
      if (!paneId) throw new Error("The original hire never recorded a pane; settle it as abandoned instead");
      if (allocation?.pane !== undefined && allocation.pane !== paneId)
        throw new Error("The receipt and project allocation name different panes");
      const [, keyHarness, keyCwd] = original ? (JSON.parse(original[0]) as string[]) : [];
      const harness = keyHarness ?? allocation!.request.harness;
      const cwd = keyCwd ?? allocation!.request.workingDirectory;
      if (
        allocation &&
        (allocation.request.harness !== harness || allocation.request.workingDirectory !== cwd)
      )
        throw new Error("The receipt and project allocation name different launches");
      if (receipt?.recoveryRequested) throw new Error("The original is under remote recovery");
      if (
        (original && ctx.activeHires.has(original[0])) ||
        (allocation && ctx.activeProjectHires.has(allocation.id))
      )
        throw new Error("The original hire is still active");
      // A this-machine hire may sit in the desktop app's terminals (ADR 0319): the recorded
      // pane decides which complete inventory observes it, as abandonment does.
      const paneFleet = splitFleetQualified(paneId)?.fleet;
      if (paneFleet !== undefined && paneFleet !== HERDR_CORE_FLEET)
        throw new Error(`Pane ${paneId} is not on this machine`);
      if (original) ctx.activeHires.add((fenced = original[0]));
      if (allocation) ctx.activeProjectHires.add((fencedAllocation = allocation.id));
      const observe = async () => {
        const inventory = await ctx.runner.list!(paneFleet);
        const agent = inventory.find((entry) => entry.paneId === paneId);
        if (!agent)
          throw new Error(
            `Pane ${paneId} is absent; settle its receipt as abandoned or release its allocation`,
          );
        if (agent.agent !== harness || agent.session === undefined)
          throw new Error(`Pane ${paneId} holds no observed ${harness} session to adopt`);
        if (!agentInDirectory(agent, cwd, "posix"))
          throw new Error(`Pane ${paneId} runs outside the hire's directory`);
        const occupantId = occupantIdForHerdrSession(agent.session);
        const sessionId = nativeSessionId(agent);
        if (
          (receipt?.occupantId !== undefined && receipt.occupantId !== occupantId) ||
          (receipt?.sessionId !== undefined && receipt.sessionId !== sessionId) ||
          (allocation?.occupantId !== undefined &&
            (allocation.occupantId !== occupantId || allocation.seat !== agent.terminalId))
        )
          throw new Error(`Pane ${paneId} holds a different occupant than the original hire observed`);
        return { inventory, agent, occupantId, sessionId };
      };
      const first = await observe();
      const claim = ctx.hireOwners.claim(paneId, first.agent.terminalId, first.occupantId);
      const owner = claim?.owner ?? ctx.hireOwners.pendingOwner(paneId);
      if (!owner) throw new Error(`No conversation's hire holds pane ${paneId}`);
      const proof =
        allocation && !allocation.confirmed
          ? // allow-swallowed-rejection -- Missing process proof refuses adoption of an unconfirmed allocation below.
            await ctx.projectPolicy?.proof?.("default", paneId).catch(() => undefined)
          : undefined;
      if (
        allocation &&
        !allocation.confirmed &&
        (!proof ||
          proof.nativeOccupantId !== first.occupantId ||
          proof.pane !== paneId ||
          proof.fleet !== "default")
      )
        throw new Error(`Pane ${paneId} has no current process proof matching its occupant`);
      await guard();
      const final = await observe();
      if (final.agent.terminalId !== first.agent.terminalId || final.occupantId !== first.occupantId)
        throw new Error("The original pane's occupant changed during census");
      // No await follows the final observation before the durable adoption.
      if (ctx.closed) throw new Error("Native hire service is closed");
      const { agent, occupantId, sessionId } = final;
      if (!claim)
        ctx.hireOwners.bind(
          paneId,
          owner,
          agent.terminalId,
          undefined,
          occupantId,
          sessionId === undefined ? undefined : JSON.stringify([ownerKeyFleet(paneId), harness, sessionId]),
          allocation?.projectId,
        );
      let evidence: LocalHireSettlementEvidence | undefined;
      if (original) {
        evidence = {
          receiptId: original[1].messageId,
          receiptKey: original[0],
          fingerprint: original[1].fingerprint,
          disposition: "adopted",
          journal: "local-host-inventory",
          census: {
            observedAt: Date.now(),
            panes: final.inventory.length,
            sha256: createHash("sha256")
              .update(JSON.stringify(final.inventory.map((pane) => [pane.paneId, pane.terminalId]).sort()))
              .digest("hex"),
          },
          pane: {
            paneId,
            present: true,
            terminalId: agent.terminalId,
            occupantId,
            ...(sessionId === undefined ? {} : { sessionId }),
            owner: { conversationId: owner.conversationId },
          },
        };
        ctx.hireReceipts.settleLocal(original[0], original[1].messageId, evidence);
      }
      // The settled original is the retirement barrier's release, so it is durable first:
      // a failed save leaves the allocation unconfirmed and the original still fenced.
      if (allocation && !allocation.confirmed) {
        ctx.projectHires.observe(allocation.id, agent.terminalId, occupantId, proof);
        ctx.projectHires.confirmed(allocation.id);
      }
      ctx.watchHiredSeat(agent.terminalId, occupantId, owner);
      return {
        state: "adopted",
        receiptId: id,
        seat: {
          paneId,
          seatId: agent.terminalId,
          occupantId,
          ...(sessionId === undefined ? {} : { sessionId }),
        },
        owner: { conversationId: owner.conversationId },
        ...(allocation ? { allocationId: allocation.id } : {}),
        ...(evidence ? { evidence } : {}),
        detail:
          "Adopted the exact occupant for its hiring conversation. Its brief's delivery stays unknown: the lead should message it to confirm its task. Nothing was sent, replayed or closed.",
      };
    } catch (error) {
      return refused(
        `Local adoption refused: ${reasonDetail(error)}. Original retained; nothing sent, closed or relaunched.`,
      );
    } finally {
      if (fenced) ctx.activeHires.delete(fenced);
      if (fencedAllocation) ctx.activeProjectHires.delete(fencedAllocation);
    }
  }

  /** Whether an adoption names a hire on another fleet machine: its receipt or its allocation. */
  function remoteAdoption(id: string): boolean {
    try {
      const original = ctx.hireReceipts.entries().find(([, receipt]) => receipt.messageId === id);
      if (original) return !thisMachineReceiptFleet(JSON.parse(original[0])[0]);
      // A settled receipt leaves the pending set; a remote host's evidence names its fleet.
      const settled = ctx.hireReceipts.settlement(id);
      if (settled) return "target" in settled && !thisMachineReceiptFleet(settled.target.fleet);
      const allocation = ctx.projectHires.allocation(id);
      return allocation?.request.fleet !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Operator adoption of a hire on another fleet machine (#326): a hire that never
   * confirmed, such as one that waited on its harness's folder-trust prompt, runs idle
   * in its own pane with no session on its receipt. The fleet's census must show that
   * pane holding the hire's harness in its directory, twice and unchanged, and the
   * host's receipt program attests the same session before the receipt settles. An
   * older allocation whose original receipt can't be matched is adopted from the
   * census alone. Binds that exact occupant to the conversation that hired the pane
   * and confirms its allocation from matching process proof. Never sends, replays or
   * closes anything, and never claims the brief arrived.
   */
  async function adoptRemoteHire(id: string, guard: () => Promise<void>): Promise<HireReceiptSettlement> {
    const refused = (detail: string): HireReceiptSettlement => ({ state: "refused", receiptId: id, detail });
    let fenced: string | undefined;
    let fencedAllocation: string | undefined;
    try {
      await guard();
      if (ctx.closed || !ctx.runner.list) throw new Error("Complete fleet Herdr inventory is unavailable");
      const settled = ctx.hireReceipts.settlement(id);
      if (settled && "disposition" in settled && settled.disposition === "adopted") {
        // A repeat reads the retained adoption: its occupant, as the census shows it now.
        const { allocation } = settled as HireRecoveryEvidence;
        if (!("paneId" in allocation)) throw new Error("The retained adoption names no pane");
        const fleet = splitFleetQualified(allocation.paneId)?.fleet;
        const agent = (await ctx.runner.list(fleet)).find((entry) => entry.paneId === allocation.paneId);
        const claim =
          agent?.session &&
          agent.terminalId === allocation.terminalId &&
          agent.session.value === allocation.sessionId
            ? ctx.hireOwners.claim(agent.paneId, agent.terminalId, occupantIdForHerdrSession(agent.session))
            : undefined;
        if (!agent?.session || !claim)
          throw new Error("Already adopted; that occupant no longer runs in its pane");
        const sessionId = nativeSessionId(agent);
        return {
          state: "adopted",
          receiptId: id,
          seat: {
            paneId: agent.paneId,
            seatId: agent.terminalId,
            occupantId: occupantIdForHerdrSession(agent.session),
            ...(sessionId === undefined ? {} : { sessionId }),
          },
          owner: { conversationId: claim.owner.conversationId },
          evidence: settled as HireRecoveryEvidence,
          detail: "Already adopted; the retained adoption is unchanged.",
        };
      }
      let original = ctx.hireReceipts.entries().find(([, receipt]) => receipt.messageId === id);
      let allocation = ctx.projectHires.allocation(id);
      if (original && original[1].freshHire)
        throw new Error("A fresh intent settles with not-launched, abandoned or abandoned-unknown");
      const fleet = original ? (JSON.parse(original[0])[0] as string) : allocation?.request.fleet;
      if (fleet === undefined || thisMachineReceiptFleet(fleet))
        throw new Error("Only a hire on another fleet machine is adopted here");
      if (original?.[1].paneId && !allocation)
        allocation = ctx.projectHires.retirementCandidate(fleet, original[1].paneId);
      if (allocation && !original) {
        // The one unresolved original at the allocation's own pane, when there is one.
        const { harness, workingDirectory: cwd } = allocation.request;
        const matches = ctx.hireReceipts.entries().filter(([key, receipt]) => {
          const [keyFleet, keyHarness, keyCwd] = JSON.parse(key) as string[];
          return (
            keyFleet === fleet &&
            keyHarness === harness &&
            keyCwd === cwd &&
            receipt.paneId === allocation!.pane &&
            !receipt.freshHire
          );
        });
        if (matches.length > 1) throw new Error("The allocation's pane has more than one unresolved receipt");
        original = matches[0];
      }
      if (!original && !allocation)
        throw new Error("No unresolved fleet hire receipt or project allocation has this UUID");
      if (allocation && (allocation.gone || allocation.request.fleet !== fleet || !allocation.started))
        throw new Error(`Allocation ${allocation.id} is not a started hire on ${fleet}`);
      const receipt = original?.[1];
      const paneId = receipt?.paneId ?? allocation?.pane;
      if (!paneId)
        throw new Error(
          "The original hire never recorded a pane; settle it as abandoned-unknown or not-launched",
        );
      if (splitFleetQualified(paneId)?.fleet !== fleet) throw new Error(`Pane ${paneId} is not on ${fleet}`);
      if (allocation?.pane !== undefined && allocation.pane !== paneId)
        throw new Error("The receipt and project allocation name different panes");
      const [, keyHarness, keyCwd] = original ? (JSON.parse(original[0]) as string[]) : [];
      const harness = keyHarness ?? allocation!.request.harness;
      const cwd = keyCwd ?? allocation!.request.workingDirectory;
      if (!harness || !cwd) throw new Error("The original hire's launch identity is incomplete");
      if (
        allocation &&
        (allocation.request.harness !== harness || allocation.request.workingDirectory !== cwd)
      )
        throw new Error("The receipt and project allocation name different launches");
      if (receipt?.recoveryRequested) throw new Error("The original is under remote recovery");
      if (receipt?.settlement) throw new Error("The original receipt already has a retained disposition");
      if (
        (original && ctx.activeHires.has(original[0])) ||
        (allocation && ctx.activeProjectHires.has(allocation.id))
      )
        throw new Error("The original hire is still active");
      // Without a receipt, no other unresolved hire may claim this place: adoption must not
      // pick between competing originals.
      if (!original && ctx.hireReceipts.entries().some(([, entry]) => entry.paneId === paneId))
        throw new Error("An unresolved receipt names this pane; adopt it by that receipt");
      if (original) ctx.activeHires.add((fenced = original[0]));
      if (allocation) ctx.activeProjectHires.add((fencedAllocation = allocation.id));
      // The fleet's own shell decides how its paths compare. Claiming reads its configuration only.
      if (!ctx.remoteHireReceipts) throw new Error("The fleet's host receipt program is unavailable");
      const shell =
        receipt?.remoteAdmission?.target.shell ??
        (await ctx.remoteHireReceipts.claim(fleet, { receiptId: id, receiptKey: id, fingerprint: "" }))
          ?.target.shell;
      if (shell === undefined) throw new Error(`${fleet} is not a configured remote host`);
      const observe = async () => {
        const inventory = await ctx.runner.list!(fleet);
        const agent = inventory.find((entry) => entry.paneId === paneId);
        if (!agent) throw new Error(`Pane ${paneId} is absent; settle its receipt as abandoned instead`);
        if (agent.agent !== harness || agent.session === undefined)
          throw new Error(`Pane ${paneId} holds no observed ${harness} session to adopt`);
        if (!agentInDirectory(agent, cwd, shell))
          throw new Error(`Pane ${paneId} runs outside the hire's directory`);
        const occupantId = occupantIdForHerdrSession(agent.session);
        const sessionId = nativeSessionId(agent);
        if (
          (receipt?.occupantId !== undefined && receipt.occupantId !== occupantId) ||
          (receipt?.sessionId !== undefined && receipt.sessionId !== sessionId) ||
          (allocation?.occupantId !== undefined &&
            (allocation.occupantId !== occupantId || allocation.seat !== agent.terminalId))
        )
          throw new Error(`Pane ${paneId} holds a different occupant than the original hire observed`);
        return { agent, occupantId, sessionId, session: agent.session.value };
      };
      const first = await observe();
      const claim = ctx.hireOwners.claim(paneId, first.agent.terminalId, first.occupantId);
      const owner = claim?.owner ?? ctx.hireOwners.pendingOwner(paneId);
      if (!owner) throw new Error(`No conversation's hire holds pane ${paneId}`);
      const proof =
        allocation && !allocation.confirmed
          ? // allow-swallowed-rejection -- an unreadable proof is no proof; the adoption below refuses.
            await ctx.projectPolicy?.proof?.(fleet, paneId).catch(() => undefined)
          : undefined;
      if (
        allocation &&
        !allocation.confirmed &&
        (!proof ||
          proof.nativeOccupantId !== first.occupantId ||
          proof.pane !== paneId ||
          proof.fleet !== fleet)
      )
        throw new Error(`Pane ${paneId} has no current process proof matching its occupant`);
      let evidence: HireRecoveryEvidence | undefined;
      if (original) {
        let hostClaim = ctx.remoteClaim(original[0], original[1]);
        if (!hostClaim) {
          hostClaim = await ctx.remoteHireReceipts.claim(fleet, {
            receiptId: original[1].messageId,
            receiptKey: original[0],
            fingerprint: original[1].fingerprint,
          });
          if (!hostClaim) throw new Error("The original is not on a configured remote host");
          // Keep the exact claim before crossing SSH, so a lost reply is retried with it.
          ctx.hireReceipts.update(original[0], original[1].messageId, {
            remoteAdmission: { target: hostClaim.target, nonce: hostClaim.nonce },
          });
        }
        await guard();
        evidence = await ctx.remoteHireReceipts.recover(hostClaim, {
          disposition: "adopted",
          paneId,
          cwd,
          harness,
        });
        if (
          evidence.disposition !== "adopted" ||
          !("paneId" in evidence.allocation) ||
          evidence.allocation.terminalId !== first.agent.terminalId ||
          evidence.allocation.sessionId !== first.session
        )
          throw new Error("The host attested a different occupant than the fleet census");
      }
      await guard();
      const final = await observe();
      if (final.agent.terminalId !== first.agent.terminalId || final.occupantId !== first.occupantId)
        throw new Error("The original pane's occupant changed during census");
      // No await follows the final observation before the durable adoption.
      if (ctx.closed) throw new Error("Native hire service is closed");
      const { agent, occupantId, sessionId } = final;
      if (original && evidence) ctx.hireReceipts.settleRecovery(original[0], original[1].messageId, evidence);
      if (!claim)
        ctx.hireOwners.bind(
          paneId,
          owner,
          agent.terminalId,
          undefined,
          occupantId,
          sessionId === undefined ? undefined : JSON.stringify([fleet, harness, sessionId]),
          allocation?.projectId,
        );
      if (allocation && !allocation.confirmed) {
        ctx.projectHires.observe(allocation.id, agent.terminalId, occupantId, proof);
        ctx.projectHires.confirmed(allocation.id);
      }
      ctx.watchHiredSeat(agent.terminalId, occupantId, owner);
      return {
        state: "adopted",
        receiptId: id,
        seat: {
          paneId,
          seatId: agent.terminalId,
          occupantId,
          ...(sessionId === undefined ? {} : { sessionId }),
        },
        owner: { conversationId: owner.conversationId },
        ...(allocation ? { allocationId: allocation.id } : {}),
        ...(evidence ? { evidence } : {}),
        detail: `Adopted the exact occupant on ${fleet} for its hiring conversation.${
          original
            ? ""
            : " No original receipt matched this allocation; the census alone proved its occupant."
        } Its brief's delivery stays unknown: the lead should message it to confirm its task. Nothing was sent, replayed or closed.`,
      };
    } catch (error) {
      return refused(
        `Fleet adoption refused: ${reasonDetail(error)}. Original retained; nothing sent, closed or relaunched.`,
      );
    } finally {
      if (fenced) ctx.activeHires.delete(fenced);
      if (fencedAllocation) ctx.activeProjectHires.delete(fencedAllocation);
    }
  }

  /**
   * Auto-tidy's operator adoption (VUH-2802): a local project hire that never confirmed is
   * adopted only when its original receipt observed this exact native session and occupant,
   * and its hiring conversation is the one tidy would close it for. Everything else stays
   * for the lead, and the close keeps every other refusal.
   */
  async function adoptUnconfirmedForTidy(
    agent: HerdrAgentSnapshot,
    owner: ConversationOwner,
    guard: () => Promise<void>,
  ): Promise<HireReceiptSettlement | undefined> {
    const paneFleet = splitFleetQualified(agent.paneId)?.fleet;
    if (ctx.closed || (paneFleet !== undefined && paneFleet !== HERDR_CORE_FLEET) || !agent.session)
      return undefined;
    const candidate = ctx.projectHires.retirementCandidate("default", agent.paneId);
    if (!candidate || candidate.confirmed || candidate.request.freshIntent) return undefined;
    const occupantId = occupantIdForHerdrSession(agent.session);
    const sessionId = nativeSessionId(agent);
    const claim = ctx.hireOwners.claim(agent.paneId, agent.terminalId, occupantId);
    if (!claim?.hired || claim.owner.conversationId !== owner.conversationId) return undefined;
    // The same single original the retirement guard requires to be settled.
    let originals: readonly (readonly [string, UncertainReceipt])[];
    try {
      originals = ctx.hireReceipts
        .all()
        .filter(
          ([, receipt]) => receipt.paneId === agent.paneId && receipt.occupantId === candidate.occupantId,
        );
    } catch {
      return undefined;
    }
    const original = originals.length === 1 ? originals[0]![1] : undefined;
    if (
      !original ||
      original.settlement ||
      original.completed ||
      original.abandoned ||
      original.occupantId !== occupantId ||
      sessionId === undefined ||
      original.sessionId !== sessionId
    )
      return undefined;
    return ctx.adoptLocalHire(original.messageId, guard);
  }

  async function recoverHireReceipt(
    receiptId: string,
    guard: () => Promise<void>,
    disposition: "delivered" | "abandoned" | "abandoned-unknown",
  ): Promise<HireReceiptSettlement> {
    const refused = (detail: string): HireReceiptSettlement => ({ state: "refused", receiptId, detail });
    try {
      if (ctx.closed) return refused("Native hire service is closed; original remains fenced.");
      const unknown = disposition === "abandoned-unknown";
      const channel = disposition === "delivered" ? await ctx.channelReceipt?.(receiptId) : undefined;
      if (disposition === "delivered" && !channel)
        return refused("Exact original channel receipt is unavailable.");
      if (channel && !channel.receipt.sessionId && !channel.acknowledged)
        return refused("Legacy channel recovery requires its retained exact bridge acknowledgment.");
      const settled = channel?.receipt.settlement ?? ctx.hireReceipts.settlement(receiptId);
      if (settled && settled.journal === "authenticated-recovery" && settled.disposition === disposition)
        return {
          state: disposition === "delivered" ? "settled-delivered" : "abandoned",
          receiptId,
          evidence: settled,
        };
      if (settled) return refused("Original receipt already has a different retained disposition.");
      const originals = ctx.hireReceipts
        .entries()
        .filter(([, receipt]) =>
          disposition !== "delivered"
            ? receipt.messageId === receiptId
            : receipt.fingerprint === channel!.receipt.fingerprint &&
              splitFleetQualified(receipt.paneId ?? "")?.fleet ===
                splitFleetQualified(channel!.seatId)?.fleet,
        );
      if (originals.length !== 1 || !ctx.remoteHireReceipts)
        return refused("Original allocated remote hire is missing or ambiguous.");
      const [key, receipt] = originals[0]!;
      if (ctx.activeHires.has(key)) return refused("Original hire is still active.");
      if (!unknown && !receipt.paneId)
        return refused(
          "Original has no mapped pane. A fresh remote Codex admission may be settled with abandoned-unknown; not-launched still requires its retained host reservation window.",
        );
      const [fleet, harness, cwd, nativeSession] = JSON.parse(key) as string[];
      if (!fleet || !harness || !cwd || (!unknown && splitFleetQualified(receipt.paneId!)?.fleet !== fleet))
        return refused("Original remote allocation identity is incomplete.");
      if (
        unknown &&
        (harness !== "codex" ||
          nativeSession !== "new" ||
          !receipt.remoteAdmission ||
          receipt.remoteAdmission.target.fleet !== fleet ||
          receipt.paneId ||
          receipt.sessionId ||
          receipt.occupantId)
      )
        return refused("Unknown abandonment requires an unmapped original fresh Codex admission.");
      let claim = ctx.remoteClaim(key, receipt);
      // Unknown recovery must fence the original before any further authority/host await.
      if (unknown) ctx.hireReceipts.update(key, receipt.messageId, { recoveryRequested: true });
      await guard();
      if (ctx.closed || ctx.activeHires.has(key))
        return refused("Original hire is active or service closed; recovery cannot begin.");
      if (!unknown) ctx.hireReceipts.update(key, receipt.messageId, { recoveryRequested: true });
      if (!claim) {
        claim = await ctx.remoteHireReceipts.claim(fleet, {
          receiptId: receipt.messageId,
          receiptKey: key,
          fingerprint: receipt.fingerprint,
        });
        if (!claim) return refused("Original allocation is not a configured remote host.");
        await guard();
        // A legacy recovery claim cannot masquerade as a historical no-launch window.
        ctx.hireReceipts.update(key, receipt.messageId, {
          remoteAdmission: { target: claim.target, nonce: claim.nonce },
          remoteLaunchCommitted: true,
        });
      }
      await guard();
      if (ctx.closed || ctx.activeHires.has(key))
        return refused("Original hire is active or service closed; recovery cannot begin.");
      const evidence = await ctx.remoteHireReceipts.recover(claim, {
        disposition,
        ...(unknown && !receipt.remoteLaunchCommitted ? { launchUncommitted: true as const } : {}),
        ...(unknown ? {} : { paneId: receipt.paneId! }),
        cwd,
        harness,
        ...(!unknown && receipt.beforeIds ? { beforeIds: receipt.beforeIds } : {}),
        ...(channel
          ? {
              message: {
                receiptId,
                seatId: channel.seatId,
                ...(channel.receipt.sessionId ? { binding: channel.receipt.sessionId } : {}),
              },
            }
          : {}),
      });
      await guard();
      if (ctx.closed || ctx.activeHires.has(key))
        return refused("Original hire became active or service closed; receipt remains fenced.");
      if (evidence.disposition !== disposition)
        return refused("Host recovery disposition changed; original remains fenced.");
      if (channel) channel.settle(evidence);
      else ctx.hireReceipts.settleRecovery(key, receiptId, evidence);
      return { state: disposition === "delivered" ? "settled-delivered" : "abandoned", receiptId, evidence };
    } catch (error) {
      return refused(
        `Authenticated recovery refused: ${reasonDetail(error)}. Original retained; nothing sent or relaunched.`,
      );
    }
  }
  return {
    retireCompletedHires,
    settleHireReceipt,
    settleNativeHireReceipt,
    localHireReceipt,
    shellOnlyPane,
    unrecordedHireStale,
    retireGoneProjectHires,
    retireGoneLocalHires,
    retireUnsentRemoteAt,
    retireUnsentRemoteHires,
    abandonLocalHireReceipt,
    releaseSettledHireAllocation,
    adoptLocalHire,
    remoteAdoption,
    adoptRemoteHire,
    adoptUnconfirmedForTidy,
    recoverHireReceipt,
  };
}
