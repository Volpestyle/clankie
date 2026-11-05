import { readGithubOriginSlug } from "./seat-telemetry.ts";
import { pointedBrief } from "./brief-file.ts";
import { hireAdmissionReport, hireAdmissionChoice, HireAdmissionError } from "./hire-admission.ts";
import { savedSessionHarness } from "../agent-sessions.ts";
import { realpath } from "node:fs/promises";
import { projectHireProfile } from "./project-hires.ts";
import {
  captureConversationAuthority,
  conversationAuthorityGuard,
  assertConversationAuthority,
  type ConversationAuthority,
} from "./conversation-owner.ts";
import {
  DeliveryFence,
  deliveryFingerprint,
  readsBackAs,
  sentFingerprints,
  type UncertainReceipt,
} from "./delivery-fence.ts";
import { channelBody } from "./claude-worker-seat.ts";
import { hireDeliveryStage } from "@clankie/protocol";
import { existingNativeSession, nativeSessionId } from "./native-session-resume.ts";
import type { SavedAgentSession } from "../agent-sessions.ts";
import { projectsRevision } from "@clankie/settings";
import { isDeepStrictEqual } from "node:util";
import { redactSensitiveText } from "@clankie/observability";
import {
  effectiveHireProfile,
  HIRE_NO_PREFERENCE,
  type SpawnOperatorSeat as HireRequest,
} from "@clankie/protocol";
import { occupantIdForHerdrSession } from "./herdr-census.ts";
import type { RemoteHireClaim } from "../remote-hire-receipts.ts";
import {
  chooseWorkerHarness,
  type MachineWorkerAccounts,
  type WorkerAccountHarness,
} from "./harness-accounts.ts";
import {
  type HerdrWatchRecord,
  type HerdrAgentSnapshot,
  type SpawnOperatorSeat,
  type HireAuthority,
  type AdoptHire,
  type HerdrSeatSpawnResult,
  type HerdrSeatSpawnFailure,
} from "./herdr-watch-types.ts";
import {
  reasonDetail,
  spawnedSeat,
  bounded,
  hireProfileBrief,
  effortFreeDefaults,
  thisMachineReceiptFleet,
} from "./herdr-watch-helpers.ts";
import type { HerdrWatchContext } from "./herdr-watch-context.ts";

type Context = Pick<
  HerdrWatchContext,
  | "activeHires"
  | "activeProjectHires"
  | "admitProjectLaunch"
  | "assertRemoteHireAuthority"
  | "bindHireOwner"
  | "briefStateDir"
  | "chooseHireHarness"
  | "closed"
  | "fleetHireTools"
  | "fleetResources"
  | "hireDefaultPolicies"
  | "hireDefaults"
  | "hireHarnessReasons"
  | "hireOwners"
  | "hireReceipts"
  | "hireRefusal"
  | "launch"
  | "nativeLaunchPolicy"
  | "observeHireIdentity"
  | "performSpawnSeat"
  | "projectAllocations"
  | "projectContexts"
  | "projectHireBlocker"
  | "projectHires"
  | "projectLiveReuse"
  | "projectPolicy"
  | "projectPolicyQueue"
  | "projectRecoveryOnly"
  | "remoteClaim"
  | "remoteHireReceipts"
  | "remoteLaunches"
  | "requireWorkerAccess"
  | "resolveHireModels"
  | "resolveModel"
  | "resumeSeat"
  | "resumeStarts"
  | "retireCompletedHires"
  | "retireGoneLocalHires"
  | "retireGoneProjectHires"
  | "retireUnsentRemoteAt"
  | "retireUnsentRemoteHires"
  | "runProjectPolicy"
  | "runner"
  | "spawnAdmittedSeat"
  | "startSeat"
  | "validateOwner"
  | "wake"
  | "watchHiredSeat"
  | "workHires"
  | "workerAccountsReport"
>;

export function createHerdrWatchHiring(ctx: Context) {
  async function spawnSeat(
    inputRequest: HireRequest,
    subjectOverride?: string,
    brief?: string,
    resume?: SavedAgentSession,
    authority?: HireAuthority,
    adopt?: AdoptHire,
    flushAdoption?: () => Promise<void>,
    taskBrief = brief !== undefined,
    leadFingerprint?: string,
  ): Promise<HerdrSeatSpawnResult> {
    const work =
      taskBrief ||
      inputRequest.deliverable !== undefined ||
      inputRequest.effortReason !== undefined ||
      authority?.ownerHire !== undefined;
    const { effort: _retiredEffort, ...defaults } = (await ctx.hireDefaults?.()) ?? {};
    if (inputRequest.ownerWork)
      return {
        outcome: "failed",
        reason: "not_ready",
        detail: "Owner app provenance must be verified by the owner service route.",
      };
    // Only Claude has a read-only mode Clankie can start it in (ADR 0320). A
    // resumed transcript keeps the mode it was saved under, so it never resumes.
    if (inputRequest.readOnly === true && (inputRequest.harness !== "claude" || resume !== undefined))
      return {
        outcome: "failed",
        reason: "harness_unavailable",
        detail: "Only a new Claude hire can start read-only.",
      };
    try {
      await ctx.requireWorkerAccess?.(inputRequest.fleet);
    } catch (error) {
      return { outcome: "failed", reason: "not_ready", detail: reasonDetail(error) };
    }
    let input = { ...inputRequest, ...effectiveHireProfile(inputRequest, {}, defaults) };
    // `auto` is "no preference" over any role or fleet default: Clankie picks per machine.
    if (input.account === HIRE_NO_PREFERENCE) {
      const { account: _auto, ...rest } = input;
      input = rest;
    }
    // No layer named a harness: choose one for this hire outside a project. A
    // project hire chooses below, once its role's fields are known.
    const unprojected = async (): Promise<SpawnOperatorSeat | HerdrSeatSpawnResult> => {
      const chosen =
        input.harness === undefined
          ? await ctx.chooseHireHarness(input, resume, undefined, work, authority?.ownerHire)
          : undefined;
      if (chosen !== undefined && "outcome" in chosen) return chosen;
      const seat = { ...input, harness: input.harness ?? chosen!.harness };
      ctx.hireDefaultPolicies.set(seat, JSON.stringify(defaults));
      if (chosen?.why !== undefined) ctx.hireHarnessReasons.set(seat, chosen.why);
      return seat;
    };
    if (!ctx.projectPolicy && input.delegation === "native-first")
      return {
        outcome: "failed",
        reason: "not_ready",
        detail: "Native-first hiring requires a verified project and stable deliverable key.",
      };
    if (!ctx.projectPolicy) {
      const seat = await unprojected();
      if ("outcome" in seat) return seat;
      return ctx
        .spawnAdmittedSeat(
          seat,
          subjectOverride,
          brief,
          resume,
          authority,
          adopt,
          flushAdoption,
          work,
          leadFingerprint,
        )
        .then((result) =>
          result.outcome === "spawned" ? { ...result, profile: effectiveHireProfile(seat) } : result,
        );
    }
    let allocation: string | undefined;
    try {
      if (authority) await assertConversationAuthority(authority);
      if (input.fleet === undefined) {
        // allow-swallowed-rejection -- An unreadable directory is refused as unknown_directory below.
        const canonicalDirectory = await realpath(input.workingDirectory).catch(() => undefined);
        if (canonicalDirectory === undefined)
          return { outcome: "failed", reason: "unknown_directory", detail: input.workingDirectory };
        input = { ...input, workingDirectory: canonicalDirectory };
        if (resume === undefined && input.freshIntent === undefined)
          await ctx.retireGoneProjectHires(input.workingDirectory, conversationAuthorityGuard(authority));
      }
      const settings = await ctx.projectPolicy.settings();
      const projectId = await ctx.projectPolicy.project(input, settings, authority);
      if (input.projectId !== undefined && input.projectId !== projectId)
        throw new Error("The selected project does not match this hiring conversation or workspace.");
      if (input.fleet !== undefined && resume === undefined) {
        await ctx.retireUnsentRemoteAt(input, conversationAuthorityGuard(authority), projectId);
        if (authority !== undefined) await assertConversationAuthority(authority);
      }
      if (projectId === undefined) {
        if (input.delegation === "native-first")
          throw new Error("Native-first hiring requires a verified project and stable deliverable key.");
        if (ctx.projectHires.unresolved(input))
          throw new Error(
            "An earlier hire in this workspace is still being checked. Resolve it before hiring again.",
          );
        const seat = await unprojected();
        if ("outcome" in seat) return seat;
        return ctx
          .spawnAdmittedSeat(
            seat,
            subjectOverride,
            brief,
            resume,
            authority,
            adopt,
            flushAdoption,
            work,
            leadFingerprint,
          )
          .then((result) =>
            result.outcome === "spawned" ? { ...result, profile: effectiveHireProfile(seat) } : result,
          );
      }
      let hireRequest =
        inputRequest.workingDirectory === input.workingDirectory
          ? inputRequest
          : { ...inputRequest, workingDirectory: input.workingDirectory };
      // No request, role or fleet harness: choose one now, recorded as this hire's own choice.
      const planned = projectHireProfile(settings, projectId, hireRequest, defaults);
      const projectHiring = settings.projects.find((project) => project.id === projectId)?.hiring;
      if (
        projectHiring?.excludedModels?.some(
          (model) => model === planned.model || model === planned.subagents?.model,
        )
      )
        throw new Error("This model is excluded by the project's hiring policy.");
      let harnessReason: string | undefined;
      if (planned.harness === undefined) {
        const chosen = await ctx.chooseHireHarness(
          planned,
          resume,
          projectHiring,
          work,
          authority?.ownerHire,
        );
        if ("outcome" in chosen) return chosen;
        hireRequest = { ...hireRequest, harness: chosen.harness };
        harnessReason = chosen.why;
      }
      let live: HerdrAgentSnapshot | undefined;
      if (ctx.runner.list) {
        const candidates = ctx.projectHires.inventoryCandidates(input.fleet ?? "default");
        // allow-swallowed-rejection -- Unavailable inventory cannot reconcile allocations or prove a reusable live seat.
        const inventory = await ctx.runner.list(input.fleet).catch(() => undefined);
        if (inventory && resume) live = existingNativeSession(inventory, resume);
        if (inventory)
          ctx.projectHires.reconcile(
            input.fleet ?? "default",
            new Set(inventory.map((agent) => agent.paneId)),
            ctx.activeProjectHires,
            candidates,
          );
      }
      const reused =
        live?.session === undefined
          ? undefined
          : ctx.projectHires.reuse(settings, projectId, input, {
              pane: live.paneId,
              seat: live.terminalId,
              occupantId: occupantIdForHerdrSession(live.session),
            });
      // Pin the repository before this native launch can edit its checkout. Retried/legacy
      // allocations retain their original evidence; never backfill them from current Git config.
      const repository =
        input.fleet === undefined ? await readGithubOriginSlug(input.workingDirectory) : undefined;
      const reserved =
        reused ?? ctx.projectHires.reserve(settings, projectId, hireRequest, defaults, { repository });
      if (resume !== undefined && reserved.request.harness !== savedSessionHarness(resume)) {
        ctx.projectHires.failed(reserved.id);
        throw new Error(
          "This role now uses a different harness. Its saved session cannot be resumed with these settings.",
        );
      }
      if (ctx.activeProjectHires.has(reserved.id))
        return {
          outcome: "failed",
          reason: "start_unconfirmed",
          detail: `The earlier hire is still starting. No new agent was started. Blocking ${ctx.projectHireBlocker(reserved.id)}.`,
        };
      allocation = reserved.id;
      const harness = reserved.request.harness;
      if (harness === undefined) throw new Error("This hire's record names no harness; hire again.");
      const seat: SpawnOperatorSeat = { ...reserved.request, harness };
      ctx.hireDefaultPolicies.set(seat, JSON.stringify(defaults));
      if (harnessReason !== undefined) ctx.hireHarnessReasons.set(seat, harnessReason);
      ctx.projectAllocations.set(seat, allocation);
      ctx.projectContexts.set(seat, {
        projectId,
        projectName: settings.projects.find((project) => project.id === projectId)!.name,
        ...(authority === undefined ? {} : { authority }),
      });
      if (reused) ctx.projectLiveReuse.add(seat);
      if (reserved.reused) ctx.projectRecoveryOnly.set(seat, reserved.id);
      ctx.activeProjectHires.add(allocation);
      const result = await ctx.spawnAdmittedSeat(
        seat,
        subjectOverride,
        brief,
        resume,
        authority,
        adopt,
        flushAdoption,
        work,
        leadFingerprint,
      );
      if (result.outcome === "spawned") ctx.projectHires.confirmed(allocation);
      else ctx.projectHires.failed(allocation);
      return result.outcome === "spawned" ? { ...result, profile: effectiveHireProfile(seat) } : result;
    } catch (error) {
      if (allocation) ctx.projectHires.failed(allocation);
      return { outcome: "failed", reason: "not_ready", detail: reasonDetail(error) };
    } finally {
      if (allocation) ctx.activeProjectHires.delete(allocation);
    }
  }

  /**
   * The harness for a hire that names none at any layer. A resumed session
   * keeps its own. Otherwise the hire's machine decides from its usable
   * accounts the owner has not held, within the family of any requested model
   * (`chooseWorkerHarness`); nothing is assumed when they cannot be read.
   */
  async function chooseHireHarness(
    input: HireRequest,
    resume?: SavedAgentSession,
    policy?: import("@clankie/protocol/projects").ProjectHiringPolicy,
    work = false,
    ownerHire?: ConversationAuthority["ownerHire"],
  ): Promise<
    { readonly harness: SpawnOperatorSeat["harness"]; readonly why?: string } | HerdrSeatSpawnResult
  > {
    if (resume !== undefined) return { harness: savedSessionHarness(resume) as SpawnOperatorSeat["harness"] };
    const failed = (detail: string): HerdrSeatSpawnFailure => ({
      outcome: "failed",
      reason: "harness_unavailable",
      detail,
    });
    if (ctx.workerAccountsReport === undefined)
      return failed(
        "No harness was named and this service cannot read worker accounts to choose one. Pass harness for this hire.",
      );
    const models = [input.model, input.subagents?.model].filter((m): m is string => m !== undefined);
    const machine = input.fleet ?? "this machine";
    let report: MachineWorkerAccounts;
    try {
      report = await ctx.workerAccountsReport(input.fleet);
    } catch (error) {
      return failed(
        `No harness was named and ${machine}'s worker accounts could not be read (${reasonDetail(error)}). Pass harness for this hire.`,
      );
    }
    // Account overrides still select Claude/Codex profiles only. Pi is the
    // verified default native profile, never a substitute for a named account.
    let allowed: WorkerAccountHarness[] = [
      "claude",
      "codex",
      ...(input.account === undefined && report.accounts.some((account) => account.harness === "pi")
        ? ["pi" as const]
        : []),
    ];
    if (models.length) {
      const fits: WorkerAccountHarness[] = [];
      for (const harness of allowed) {
        try {
          const resolved = await Promise.all(
            models.map((model) => (ctx.resolveModel ? ctx.resolveModel(harness, model) : model)),
          );
          if (
            harness === "pi" &&
            !report.accounts.some(
              (account) =>
                account.harness === "pi" &&
                account.usable &&
                !account.held &&
                resolved.every((model) => account.models?.includes(model)),
            )
          )
            continue;
          fits.push(harness);
        } catch {
          /* A requested model must fit this exact harness; never relax it. */
        }
      }
      allowed = fits;
      if (!allowed.length)
        return failed("No usable worker harness can run every requested model. No pane was opened.");
    }
    if (work) {
      try {
        const canonicalModels = (
          await Promise.all(
            allowed.map(async (harness) =>
              Promise.all(
                models.map((model) => (ctx.resolveModel ? ctx.resolveModel(harness, model) : model)),
              ),
            ),
          )
        ).flat();
        const admitted = hireAdmissionReport(
          { ...report, accounts: report.accounts.filter((account) => allowed.includes(account.harness)) },
          policy,
          canonicalModels,
          Date.now(),
          ownerHire?.overrideUsage === true,
        );
        const selected = hireAdmissionChoice(admitted, undefined, input.account);
        return {
          harness: selected.account.harness as SpawnOperatorSeat["harness"],
          why: `${selected.plan}: ${selected.reason}`,
        };
      } catch (error) {
        return {
          ...failed(reasonDetail(error)),
          ...(ownerHire && error instanceof HireAdmissionError ? { admission: error.admission } : {}),
        };
      }
    }
    const choice = chooseWorkerHarness(machine, report, allowed, input.account);
    return "refused" in choice ? failed(choice.refused) : { harness: choice.harness, why: choice.why };
  }

  async function admitProjectLaunch(
    input: SpawnOperatorSeat,
    dispatched = false,
    authorityOverride?: ConversationAuthority,
  ): Promise<void> {
    await ctx.runProjectPolicy(async () => {
      await ctx.requireWorkerAccess?.(input.fleet);
      const defaultPolicy = ctx.hireDefaultPolicies.get(input);
      if (
        defaultPolicy !== undefined &&
        defaultPolicy !== JSON.stringify(effortFreeDefaults((await ctx.hireDefaults?.()) ?? {}))
      )
        throw new Error(
          "Fleet hire defaults changed during startup. Check the current profile before hiring again.",
        );
      const id = ctx.projectAllocations.get(input);
      const context = ctx.projectContexts.get(input);
      if (!id || !context || !ctx.projectPolicy) return;
      const policy = ctx.projectPolicy;
      const settings = await policy.settings();
      const project = await policy.project(input, settings, authorityOverride ?? context.authority);
      const latest = await policy.settings();
      if (project !== context.projectId || projectsRevision(settings) !== projectsRevision(latest))
        throw new Error(
          "The project's settings or workspace changed. Check the project before hiring again.",
        );
      ctx.projectHires.launch(id, latest, dispatched);
      context.projectName = latest.projects.find((entry) => entry.id === context.projectId)!.name;
    });
  }

  function runProjectPolicy(action: () => Promise<void>): Promise<void> {
    // An already-running watch can probe during live-controller reuse. Keep
    // our own adoption writes outside these before/after policy snapshots;
    // external policy changes still fail the unchanged revision fence.
    const result = ctx.projectPolicyQueue.then(action, action);
    // allow-swallowed-rejection -- The returned result carries the failure to its caller; the queue remains usable for later policy actions.
    ctx.projectPolicyQueue = result.catch(() => {});
    return result;
  }

  async function admitResourceMutation(input: SpawnOperatorSeat, authority?: HireAuthority): Promise<void> {
    if (!ctx.fleetResources) return;
    await ctx.fleetResources.admitHire(input);
    // The new admission wait cannot carry an old conversation/project grant
    // into the native mutation after that grant was revoked.
    if (authority !== undefined) await assertConversationAuthority(authority);
    await ctx.admitProjectLaunch(input);
  }

  async function expectedHireTools(input: SpawnOperatorSeat): Promise<readonly string[]> {
    const fleetTools = (await ctx.fleetHireTools?.()) ?? [];
    const project = ctx.projectContexts.get(input)?.projectId;
    if (!project) return [...new Set(fleetTools)].sort();
    if (!ctx.projectPolicy?.tools)
      throw new Error("Project catalog expectation is unavailable; no brief was sent");
    return [...new Set([...fleetTools, ...(await ctx.projectPolicy.tools(project))])].sort();
  }

  async function resolveHireModels(input: SpawnOperatorSeat): Promise<SpawnOperatorSeat> {
    // Validate without replacing the journaled friendly names; native argv uses resolved IDs.
    if (input.model && ctx.resolveModel) await ctx.resolveModel(input.harness, input.model);
    if (input.subagents?.model && ctx.resolveModel)
      await ctx.resolveModel(input.harness, input.subagents.model);
    const context = ctx.projectContexts.get(input);
    const settings = context ? await ctx.projectPolicy?.settings() : undefined;
    const policy = settings?.projects.find((project) => project.id === context?.projectId)?.hiring;
    if (
      (policy?.allowedPlans?.length || policy?.excludedPlans?.length) &&
      input.harness !== "claude" &&
      input.harness !== "codex"
    )
      throw new Error("This harness cannot prove the project's subscription-plan constraints.");
    if (policy?.excludedModels?.length || policy?.allowedModels) {
      if (!input.model)
        throw new Error("Choose an explicit model so the project's model constraints can be checked.");
      for (const model of [input.model, input.subagents?.model].filter(
        (value): value is string => value !== undefined,
      )) {
        const canonical = ctx.resolveModel ? await ctx.resolveModel(input.harness, model) : model;
        if (
          policy.excludedModels?.includes(canonical) ||
          (policy.allowedModels && !policy.allowedModels.includes(canonical))
        )
          throw new Error("This model is not permitted by the project's hiring policy.");
      }
    }
    return input;
  }

  async function spawnAdmittedSeat(
    input: SpawnOperatorSeat,
    subjectOverride?: string,
    brief?: string,
    resume?: SavedAgentSession,
    authority?: HireAuthority,
    adopt?: AdoptHire,
    flushAdoption?: () => Promise<void>,
    work = false,
    leadFingerprint?: string,
  ): Promise<HerdrSeatSpawnResult> {
    try {
      const refusal = await ctx.hireRefusal?.(input);
      if (refusal !== undefined) return { outcome: "failed", reason: "not_ready", detail: refusal };
      input = await ctx.resolveHireModels(input);
      if (work) ctx.workHires.add(input);
      const subagentModel =
        input.subagents?.model && ctx.resolveModel
          ? await ctx.resolveModel(input.harness, input.subagents.model)
          : input.subagents?.model;
      brief = hireProfileBrief(
        { ...input, ...(subagentModel ? { subagents: { ...input.subagents, model: subagentModel } } : {}) },
        brief,
      );
      brief = (await ctx.fleetResources?.hireBrief(input, brief)) ?? brief;
    } catch (error) {
      return { outcome: "failed", reason: "not_ready", detail: reasonDetail(error) };
    }
    // Persist origin before discovery or native startup can leave an uncertain pane.
    if (authority !== undefined) {
      const admitted = captureConversationAuthority(authority);
      if (resume !== undefined) {
        const resumedSessionKey = JSON.stringify([input.fleet ?? "local", input.harness, resume.sessionId]);
        const held = ctx.hireOwners.sessionOwner(resumedSessionKey);
        if (held === undefined || held.conversationId !== admitted.owner.conversationId)
          return {
            outcome: "failed",
            reason: "not_ready",
            detail: "Saved session has no matching persisted hiring conversation",
          };
        authority = {
          ...admitted,
          owner: held,
          resumedSessionKey,
          authorize: async () => (await admitted.authorize()) && (await ctx.validateOwner?.(held)) === true,
        };
      } else authority = admitted;
      // Who asked, for display only (ADR 0321): a connected app, the owner's own app, else Clankie.
      const startedBy =
        authority.connectorPlace?.deviceId !== undefined
          ? ({
              kind: "app",
              deviceId: authority.connectorPlace.deviceId,
              ...(authority.connectorPlace.channel === undefined
                ? {}
                : { channel: authority.connectorPlace.channel }),
              ...(authority.connectorPlace.notify === undefined
                ? {}
                : { notify: authority.connectorPlace.notify }),
            } as const)
          : authority.ownerHire !== undefined
            ? ({ kind: "owner" } as const)
            : undefined;
      authority = { ...authority, intentId: ctx.hireOwners.intent(authority.owner, startedBy) };
    }
    if (resume === undefined)
      return ctx.performSpawnSeat(
        input,
        subjectOverride,
        brief,
        resume,
        authority,
        adopt,
        flushAdoption,
        leadFingerprint,
      );
    // Serialize starts only inside the existing hire path. Herdr remains the
    // durable owner of the seat; there is no parallel run/lock store.
    const key = JSON.stringify([
      resume.host === "local" ? "local" : [resume.host.ssh, resume.host.shell],
      resume.sessionId.toLowerCase(),
    ]);
    const previous = ctx.resumeStarts.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    ctx.resumeStarts.set(key, current);
    await previous;
    try {
      return await ctx.performSpawnSeat(
        input,
        subjectOverride,
        brief,
        resume,
        authority,
        adopt,
        flushAdoption,
        leadFingerprint,
      );
    } finally {
      release();
      if (ctx.resumeStarts.get(key) === current) ctx.resumeStarts.delete(key);
    }
  }

  async function performSpawnSeat(
    input: SpawnOperatorSeat,
    subjectOverride?: string,
    brief?: string,
    resume?: SavedAgentSession,
    authority?: HireAuthority,
    adopt?: AdoptHire,
    flushAdoption?: () => Promise<void>,
    leadFingerprint?: string,
  ): Promise<HerdrSeatSpawnResult> {
    if (authority !== undefined) await assertConversationAuthority(authority);
    if (input.resume !== undefined && resume === undefined)
      return {
        outcome: "failed",
        reason: "not_ready",
        detail: "Saved-session metadata must be resolved before hiring",
      };
    try {
      await ctx.nativeLaunchPolicy?.admit({
        seat: structuredClone(input),
        phase: "request",
        resumed: resume !== undefined,
      });
      if (ctx.fleetResources) await ctx.fleetResources.admitHire(input);
    } catch (error) {
      return { outcome: "failed", reason: "not_ready", detail: reasonDetail(error) };
    }
    const baseReceiptKey = JSON.stringify([
      input.fleet ?? "local",
      input.harness,
      input.workingDirectory,
      resume?.sessionId ?? "new",
    ]);
    let receiptKey = baseReceiptKey;
    let fresh: ReturnType<DeliveryFence["freshHireAdmission"]> | undefined;
    if (input.freshIntent) {
      try {
        if (!authority || !brief?.trim() || resume || !ctx.remoteHireReceipts)
          throw new Error(
            "freshIntent requires current hiring authority, a new remote brief and host receipts",
          );
        const projectId = ctx.projectContexts.get(input)?.projectId ?? input.projectId;
        const freshScope = { ...input, ...(projectId === undefined ? {} : { projectId }) };
        await ctx.retireCompletedHires(input.fleet!, { baseKey: baseReceiptKey }, () =>
          assertConversationAuthority(authority),
        );
        fresh = ctx.hireReceipts.freshHireAdmission(
          baseReceiptKey,
          freshScope,
          authority.owner,
          deliveryFingerprint(brief),
        );
        const target = await ctx.remoteHireReceipts.claim(input.fleet!, {
          receiptId: input.freshIntent.id,
          receiptKey: fresh.key,
          fingerprint: deliveryFingerprint(brief),
        });
        if (!target || !isDeepStrictEqual(target.target, fresh.target))
          throw new Error(
            `The settled original's remote host target changed or disconnected; expected ${input.freshIntent.afterReceiptId}`,
          );
        await assertConversationAuthority(authority);
        // The sibling check and begin below have no await between them.
        fresh = ctx.hireReceipts.freshHireAdmission(
          baseReceiptKey,
          freshScope,
          authority.owner,
          deliveryFingerprint(brief),
        );
        receiptKey = fresh.key;
      } catch (error) {
        return { outcome: "failed", reason: "not_ready", detail: reasonDetail(error) };
      }
    }
    const latestFreshOccupant = async (expected: HerdrAgentSnapshot) => {
      await ctx.assertRemoteHireAuthority(input, receiptKey, authority);
      return ctx.runner.resolveTerminal(expected.terminalId);
    };
    const assertFreshOccupant = (expected: HerdrAgentSnapshot, latest: HerdrAgentSnapshot | undefined) => {
      if (
        !expected.session ||
        !latest?.session ||
        latest.paneId !== expected.paneId ||
        latest.terminalId !== expected.terminalId ||
        latest.agent !== input.harness ||
        nativeSessionId(latest) !== nativeSessionId(expected) ||
        occupantIdForHerdrSession(latest.session) !== occupantIdForHerdrSession(expected.session)
      )
        throw new Error("The fresh hire's exact native occupant changed before adoption");
      // No await may follow this final observation/latch before adoption and reconciliation.
      if (ctx.closed || !authority?.current())
        throw new Error("Fresh hire authority is unavailable before adoption");
    };
    // An earlier hire here whose agent is already gone fences nothing it could duplicate:
    // Clankie settles it himself from this machine's complete inventory, as the operator would.
    if (!fresh && thisMachineReceiptFleet(input.fleet ?? "local"))
      await ctx.retireGoneLocalHires(baseReceiptKey, async () => {
        if (authority !== undefined) await assertConversationAuthority(authority);
      });
    // On another machine, an earlier hire whose only effect was an unanswered workspace
    // create launched nothing: its host's census settles it as not launched (#326).
    else if (!fresh && input.fleet !== undefined)
      await ctx.retireUnsentRemoteHires(baseReceiptKey, async () => {
        if (authority !== undefined) await assertConversationAuthority(authority);
      });
    const settled = ctx.hireReceipts.settled(receiptKey);
    if (settled) {
      // A settled place on another machine takes new work only as a fresh intent (#100).
      const next = input.fleet === undefined ? undefined : ctx.hireReceipts.nextFreshIntent(baseReceiptKey);
      return {
        outcome: "failed",
        reason: "not_ready",
        detail: `Original hire ${settled.messageId} is settled. Its receipt is retained; this original intent cannot dispatch again.${
          next === undefined
            ? ""
            : ` New work here goes as freshIntent {"id":"${next.id}","afterReceiptId":"${next.afterReceiptId}"} with its own brief.`
        }`,
      };
    }
    if (fresh && ctx.hireReceipts.completed(receiptKey))
      return {
        outcome: "failed",
        reason: "not_ready",
        detail:
          "This fresh intent already settled its admission. Its retained UUID cannot launch again; inspect its original seat.",
      };
    const pending = ctx.hireReceipts.pending(receiptKey);
    if (pending?.briefNotSent)
      return {
        outcome: "failed",
        receiptId: pending.messageId,
        reason: "not_ready",
        briefDelivery: "not_sent",
        deliveryStage: "unavailable",
        detail: `Original hire ${pending.messageId}: the brief was not sent. Native launch remains retained; inspect ${pending.paneId ?? "its original pane"} before recovery. No hire or brief was replayed.`,
      };
    if (pending?.recoveryRequested)
      return {
        outcome: "failed",
        receiptId: pending.messageId,
        reason: "delivery_unconfirmed",
        deliveryStage: "uncertain",
        detail:
          "This original intent is under explicit operator recovery. It cannot launch, adopt or reconcile through a hire retry.",
      };
    if (pending !== undefined) {
      if (ctx.activeHires.has(receiptKey))
        return {
          outcome: "failed",
          receiptId: pending.messageId,
          reason: "delivery_unconfirmed",
          deliveryStage: "uncertain",
          detail: "Original hire is still active; no recovery or new dispatch began.",
        };
      ctx.activeHires.add(receiptKey);
      try {
        const agent =
          pending.paneId !== undefined
            ? // allow-swallowed-rejection -- A missing native occupant cannot prove the pending receipt was delivered.
              await ctx.runner.get(pending.paneId).catch(() => undefined)
            : undefined;
        const matchingOwner =
          authority === undefined ||
          (pending.paneId !== undefined &&
            (agent?.session === undefined
              ? ctx.hireOwners.pendingOwner(pending.paneId)
              : (ctx.hireOwners.owner(
                  pending.paneId,
                  agent.terminalId,
                  occupantIdForHerdrSession(agent.session),
                ) ?? ctx.hireOwners.pendingOwner(pending.paneId))
            )?.conversationId === authority.owner.conversationId);
        const exact =
          matchingOwner &&
          agent !== undefined &&
          agent.agent === input.harness &&
          agent.session !== undefined &&
          (pending.sessionId !== undefined || pending.occupantId !== undefined) &&
          (pending.sessionId === undefined || nativeSessionId(agent) === pending.sessionId) &&
          (pending.occupantId === undefined ||
            occupantIdForHerdrSession(agent.session) === pending.occupantId);
        const transcript =
          exact && agent !== undefined
            ? // allow-swallowed-rejection -- An unavailable transcript cannot acknowledge the pending brief.
              await ctx.runner.transcript?.(agent).catch(() => undefined)
            : undefined;
        // A brief that went by file (claude-worker-seat) arrives as a pointer to the
        // service's own brief file; the brief it names is what was delivered (#615).
        const arrived = async (text: string) => {
          if (brief === undefined) return false;
          const sent = pending.fingerprint === deliveryFingerprint(brief) ? sentFingerprints(brief) : pending;
          if (readsBackAs(text, sent)) return true;
          const pointed =
            ctx.briefStateDir === undefined ? undefined : await pointedBrief(text, ctx.briefStateDir);
          return pointed?.kind === "brief" && readsBackAs(pointed.brief, sent);
        };
        let received = brief === undefined ? exact : false;
        if (brief !== undefined && input.harness !== "pi" && pending.beforeIds !== undefined)
          for (const entry of transcript?.entries ?? [])
            if (
              entry.type === "message" &&
              entry.role === "operator" &&
              !pending.beforeIds.includes(entry.id) &&
              (await arrived(channelBody(entry.text) ?? entry.text))
            ) {
              received = true;
              break;
            }
        if (
          exact &&
          received &&
          pending.fingerprint === deliveryFingerprint(brief ?? "") &&
          agent !== undefined
        ) {
          try {
            if (fresh) assertFreshOccupant(agent, await latestFreshOccupant(agent));
          } catch (error) {
            return {
              outcome: "failed",
              receiptId: pending.messageId,
              reason: "delivery_unconfirmed",
              deliveryStage: "uncertain",
              detail: reasonDetail(error),
            };
          }
          let watch: HerdrWatchRecord | undefined;
          if (authority !== undefined) {
            await assertConversationAuthority(authority);
            await ctx.bindHireOwner(agent, input, authority);
            watch = ctx.watchHiredSeat(
              agent.terminalId,
              occupantIdForHerdrSession(agent.session!),
              ctx.hireOwners.owner(
                agent.paneId,
                agent.terminalId,
                occupantIdForHerdrSession(agent.session!),
              )!,
              false,
            );
          }
          const recovered = spawnedSeat(
            agent,
            agent.paneId,
            agent.name ?? agent.terminalId,
            input,
            undefined,
          );
          await ctx.observeHireIdentity(receiptKey, agent, input, authority);
          try {
            if (fresh) assertFreshOccupant(agent, await latestFreshOccupant(agent));
          } catch (error) {
            return {
              outcome: "failed",
              receiptId: pending.messageId,
              reason: "delivery_unconfirmed",
              deliveryStage: "uncertain",
              detail: reasonDetail(error),
            };
          }
          adopt?.(recovered, ctx.projectContexts.get(input)?.projectId);
          ctx.hireReceipts.reconcile(receiptKey, pending.messageId, input.fleet !== undefined);
          // Adoption and the exact delivery receipt commit synchronously above.
          // Its own metadata flush must precede a watch's project policy probes.
          // allow-swallowed-rejection -- The durable native receipt is already reconciled; a failed association flush stays pending.
          if (flushAdoption) await ctx.runProjectPolicy(flushAdoption).catch(() => {});
          if (watch) ctx.launch(watch);
          return { ...recovered, deliveryStage: hireDeliveryStage(recovered, brief !== undefined) };
        }
        return {
          outcome: "failed",
          receiptId: pending.messageId,
          reason: "delivery_unconfirmed",
          deliveryStage: "uncertain",
          detail: ctx.projectRecoveryOnly.has(input)
            ? `The earlier hire still needs checking. No new agent was started. Blocking ${ctx.projectHireBlocker(ctx.projectRecoveryOnly.get(input)!)}.`
            : `The original hire remains uncertain${pending.paneId === undefined ? "" : ` in pane ${pending.paneId}`}; reconcile its exact session and brief before any retry. No new seat was started.`,
        };
      } finally {
        ctx.activeHires.delete(receiptKey);
      }
    }
    const blockingAllocation = ctx.projectRecoveryOnly.get(input);
    if (blockingAllocation !== undefined)
      return {
        outcome: "failed",
        reason: "start_unconfirmed",
        detail: `The earlier hire still needs checking. No new agent was started. Blocking ${ctx.projectHireBlocker(blockingAllocation)}.`,
      };
    let receipt: UncertainReceipt;
    try {
      receipt = ctx.hireReceipts.begin(receiptKey, {
        fingerprint: deliveryFingerprint(brief ?? ""),
        ...(leadFingerprint === undefined ? {} : { leadFingerprint }),
        beganAt: Date.now(),
        ...(fresh ? { freshHire: fresh.metadata } : {}),
        ...(resume === undefined ? {} : { sessionId: resume.sessionId }),
        ...(resume === undefined ? { beforeIds: [] } : {}),
      });
      const allocation = ctx.projectAllocations.get(input);
      if (
        allocation &&
        input.fleet !== undefined &&
        !thisMachineReceiptFleet(input.fleet) &&
        resume === undefined
      )
        ctx.projectHires.bindNativeReceipt(allocation, { id: receipt.messageId, key: receiptKey });
    } catch (error) {
      return { outcome: "failed", reason: "not_ready", detail: reasonDetail(error) };
    }
    ctx.activeHires.add(receiptKey);
    let result: HerdrSeatSpawnResult;
    let watch: HerdrWatchRecord | undefined;
    let spawnedProof: HerdrAgentSnapshot | undefined;
    try {
      if (input.fleet && ctx.remoteHireReceipts) {
        const claim = await ctx.remoteHireReceipts.claim(input.fleet, {
          receiptId: receipt.messageId,
          receiptKey,
          fingerprint: receipt.fingerprint,
        });
        if (fresh && (!claim || !isDeepStrictEqual(claim.target, fresh.target)))
          throw new Error("The settled original's remote host target changed before reservation");
        if (claim) {
          // Persist the exact target/nonce before crossing SSH, including lost reserve ACKs.
          ctx.hireReceipts.update(receiptKey, receipt.messageId, {
            remoteAdmission: { target: claim.target, nonce: claim.nonce },
          });
          await ctx.remoteHireReceipts.reserve(claim);
          await ctx.assertRemoteHireAuthority(input, receiptKey, authority);
        }
      }
      result =
        resume === undefined
          ? await ctx.startSeat(input, subjectOverride, brief, undefined, receiptKey, authority)
          : await ctx.resumeSeat(input, resume, brief, receiptKey, authority);
      if (result.outcome === "spawned" && authority !== undefined) {
        const proof = await ctx.runner.resolveTerminal(result.seat.seatId);
        if (
          proof === undefined ||
          proof.paneId !== result.seat.paneId ||
          proof.session === undefined ||
          occupantIdForHerdrSession(proof.session) !== result.seat.occupantId
        )
          throw new Error("Hired seat ownership could not be bound to its exact native session");
        await assertConversationAuthority(authority);
        await ctx.bindHireOwner(proof, input, authority);
        spawnedProof = proof;
        watch = ctx.watchHiredSeat(
          result.seat.seatId,
          result.seat.occupantId,
          ctx.hireOwners.owner(result.seat.paneId, result.seat.seatId, result.seat.occupantId)!,
          false,
        );
      }
      if (result.outcome === "spawned") {
        if (fresh) {
          if (!spawnedProof) throw new Error("Fresh hire native proof is unavailable before adoption");
          assertFreshOccupant(spawnedProof, await latestFreshOccupant(spawnedProof));
        }
        adopt?.(result, ctx.projectContexts.get(input)?.projectId);
      }
      const briefNotSent = result.outcome === "failed" && result.briefDelivery === "not_sent";
      if (briefNotSent) ctx.hireReceipts.update(receiptKey, receipt.messageId, { briefNotSent: true });
      if (
        result.outcome !== "spawned" &&
        !briefNotSent &&
        ctx.hireReceipts.pending(receiptKey)?.remoteLaunchCommitted
      )
        result = { ...result, reason: "start_unconfirmed", deliveryStage: "uncertain" };
      if (
        result.outcome === "spawned" ||
        (!briefNotSent && !["start_unconfirmed", "delivery_unconfirmed"].includes(result.reason))
      )
        ctx.hireReceipts.reconcile(
          receiptKey,
          receipt.messageId,
          input.fleet !== undefined && result.outcome === "spawned",
        );
      if (result.outcome === "spawned") {
        // A failed association write stays pending; the native seat already exists.
        // allow-swallowed-rejection -- The native seat already exists; a failed association flush stays pending without replay.
        if (flushAdoption) await ctx.runProjectPolicy(flushAdoption).catch(() => {});
        if (watch) ctx.launch(watch);
      }
    } catch (error) {
      result = { outcome: "failed", reason: "start_unconfirmed", detail: String(error) };
    } finally {
      ctx.activeHires.delete(receiptKey);
      ctx.remoteLaunches.delete(receiptKey);
    }
    if (result.outcome === "failed" && authority?.intentId) {
      const detail = bounded(
        redactSensitiveText(
          `Hire did not confirm its first turn: ${result.reason}. Native receipt ${receipt.messageId}. ${result.detail ?? ""} Do not replay an uncertain brief.`,
        ),
        4000,
      );
      const pane = ctx.hireOwners.failStartup(authority.intentId, detail);
      // The durable flag remains if the native wake is unavailable.
      if (pane && ctx.wake) {
        const owner = authority.owner;
        const guard = async () => {
          if (ctx.closed || (await ctx.validateOwner?.(owner)) !== true)
            throw new Error("Hiring conversation is unavailable");
        };
        await guard()
          .then(() =>
            ctx.wake!(
              owner.conversationId,
              `Worker startup failed in ${pane}. ${detail}`,
              owner.discord,
              guard,
            ),
          )
          .catch((error) => {
            console.warn(
              "hire_agent.startup_wake_failed:",
              JSON.stringify({
                conversationId: owner.conversationId,
                paneId: pane,
                detail: bounded(redactSensitiveText(reasonDetail(error)), 1000),
              }),
            );
          });
      }
    }

    console.info(
      "hire_agent:",
      JSON.stringify({
        harness: input.harness,
        fleet: input.fleet ?? "local",
        outcome: result.outcome,
        control: result.control ?? {
          mode: "none",
          reason: result.outcome === "failed" ? result.reason : "unselected",
        },
        ...(result.outcome === "spawned"
          ? {
              seatId: result.seat.seatId,
              reason: result.control?.mode === "terminal" ? result.control.reason : "adapter_started",
            }
          : { reason: result.reason, detail: redactSensitiveText(result.detail ?? "") }),
      }),
    );
    return {
      ...result,
      ...(result.outcome === "failed" && ctx.hireReceipts.pending(receiptKey)
        ? { receiptId: receipt.messageId }
        : {}),
      deliveryStage: hireDeliveryStage(result, brief !== undefined),
    };
  }

  function remoteClaim(
    key: string,
    receipt: import("./delivery-fence.ts").UncertainReceipt,
  ): RemoteHireClaim | undefined {
    return receipt.remoteAdmission
      ? {
          receiptId: receipt.messageId,
          receiptKey: key,
          fingerprint: receipt.fingerprint,
          ...receipt.remoteAdmission,
        }
      : undefined;
  }

  /** Irreversible local guard plus the remote host's exclusive launch CAS, before every effect. */
  async function commitRemoteLaunch(key?: string, input?: SpawnOperatorSeat): Promise<void> {
    if (!key || ctx.remoteLaunches.has(key)) return;
    const receipt = ctx.hireReceipts.pending(key);
    if (!receipt) throw new Error("Original hire receipt is unavailable");
    const claim = ctx.remoteClaim(key, receipt);
    if (!claim) return;
    if (!ctx.remoteHireReceipts || receipt.remoteLaunchCommitted)
      throw new Error("Original remote launch cannot dispatch again");
    if (input) await ctx.admitProjectLaunch(input, true);
    ctx.hireReceipts.update(key, receipt.messageId, { remoteLaunchCommitted: true });
    await ctx.remoteHireReceipts.launch(claim);
    ctx.remoteLaunches.add(key);
  }

  /** SSH receipt operations do not retain the turn's authority or project/target grant. */
  async function assertRemoteHireAuthority(
    input: SpawnOperatorSeat,
    key: string | undefined,
    authority: HireAuthority | undefined,
  ): Promise<void> {
    const receipt = key === undefined ? undefined : ctx.hireReceipts.pending(key);
    if (!receipt?.remoteAdmission) return;
    if (ctx.closed) throw new Error("Native hire service is closed");
    if (authority !== undefined) await assertConversationAuthority(authority);
    const current = await ctx.remoteHireReceipts?.claim(input.fleet!, {
      receiptId: receipt.messageId,
      receiptKey: key!,
      fingerprint: receipt.fingerprint,
    });
    // This lookup performs no host operation; its unused nonce never replaces the original.
    if (!current || !isDeepStrictEqual(current.target, receipt.remoteAdmission.target))
      throw new Error("Original remote hire target changed or disconnected");
    await ctx.admitProjectLaunch(input);
    if (authority !== undefined) await assertConversationAuthority(authority);
    if (ctx.closed) throw new Error("Native hire service is closed");
  }

  /** Retire completed receipts only against a complete census on their unchanged configured host. */
  /**
   * A new remote hire at a place whose last hire was settled, or that already
   * holds fresh-intent history, can start only as a fresh intent after that
   * last receipt (#100). Returns one for a caller that asks for new work on every
   * call, such as a connected app's start_agent; undefined when an ordinary
   * hire still fits. The fence still refuses while any hire there is unresolved.
   */
  function nextFreshIntent(
    fleet: string,
    harness: string,
    workingDirectory: string,
  ): { id: string; afterReceiptId: string } | undefined {
    return ctx.hireReceipts.nextFreshIntent(JSON.stringify([fleet, harness, workingDirectory, "new"]));
  }
  return {
    spawnSeat,
    chooseHireHarness,
    admitProjectLaunch,
    runProjectPolicy,
    admitResourceMutation,
    expectedHireTools,
    resolveHireModels,
    spawnAdmittedSeat,
    performSpawnSeat,
    remoteClaim,
    commitRemoteLaunch,
    assertRemoteHireAuthority,
    nextFreshIntent,
  };
}
