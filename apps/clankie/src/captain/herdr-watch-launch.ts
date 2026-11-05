import { hireAdmissionReport, hireAdmissionChoice, HireAdmissionError } from "./hire-admission.ts";
import { HireLayoutNotStarted, HireLayoutUnconfirmed } from "./hire-layout.ts";
import { herdrAgentName, hirePaneLabel } from "./hire-name.ts";
import { savedSessionHarness } from "../agent-sessions.ts";
import { ResourceAdmissionError } from "../fleet-resource-runtime.ts";
import { realpath } from "node:fs/promises";
import { ProjectHireProcessProofSchema, type ProjectHireProcessProof } from "./project-hires.ts";
import { assertConversationAuthority, type ConversationAuthority } from "./conversation-owner.ts";
import { claudeWorkerPermissionMode } from "./claude-worker-seat.ts";
import { HERDR_CORE_FLEET } from "./herdr-core-runner.ts";
import {
  existingNativeSession,
  nativeResumeArgs,
  nativeSessionId,
  resumePaneLabel,
  savedClaudeAccount,
  savedCodexAccount,
} from "./native-session-resume.ts";
import type { SavedAgentSession } from "../agent-sessions.ts";
import type { PreparedSeatLaunch, SeatControl, SeatLaunch, SeatView } from "@clankie/agent-hosts";
import { selectLiveCodexAccount, type CodexAccount } from "@clankie/settings";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import { redactSensitiveText } from "@clankie/observability";
import { HIRE_NO_PREFERENCE } from "@clankie/protocol";
import { occupantIdForHerdrSession } from "./herdr-census.ts";
import {
  fleetSeatBriefStartsSession,
  fleetSeatCodexStartArgs,
  fleetSeatModelArgs,
  fleetSeatChromeArgs,
  fleetSeatEffortArgs,
} from "./fleet-seat.ts";
import { splitFleetQualified } from "../herdr-fleet.ts";
import { chooseWorkerAccount } from "./harness-accounts.ts";
import { WORKER_PANE_ENV, type WorkerSandbox } from "../worker-sandbox.ts";
import { workerSkills } from "./worker-skills.ts";
import { resolveHerdrSeatTranscriptPath } from "./herdr-transcript.ts";
import {
  type HerdrAgentSnapshot,
  type SpawnOperatorSeat,
  type HireAuthority,
  SPAWN_SESSION_WAIT_MS,
  SPAWN_FIRST_TURN_SESSION_WAIT_MS,
  SPAWN_SESSION_POLL_MS,
  CHANNEL_DIALOG_MARKER,
  CLAUDE_CHANNEL_CONSENT_REQUIRED,
  type SeatControlMode,
  type HerdrSeatSpawnResult,
  type HerdrSeatSpawnFailure,
} from "./herdr-watch-types.ts";
import {
  reasonDetail,
  spawnFailureReason,
  spawnedSeat,
  delay,
  startupSignIn,
} from "./herdr-watch-helpers.ts";
import type { HerdrWatchContext } from "./herdr-watch-context.ts";

type Context = Pick<
  HerdrWatchContext,
  | "accountHolds"
  | "accounts"
  | "admitProjectLaunch"
  | "admitResourceMutation"
  | "agentWithSession"
  | "assertRemoteHireAuthority"
  | "bindHireOwner"
  | "claudeAccounts"
  | "closed"
  | "commitRemoteLaunch"
  | "expectedHireTools"
  | "fleetResources"
  | "forwardNativeQuestion"
  | "hireCapacity"
  | "hireHarnessReasons"
  | "hireOwners"
  | "hireReceipts"
  | "hiredRestarts"
  | "hostedPiModel"
  | "launchSeat"
  | "maximumTrustMode"
  | "nativeCheckout"
  | "nativeLaunchPolicy"
  | "nativeSessionKey"
  | "observeHireIdentity"
  | "piNativeEnabled"
  | "projectAllocations"
  | "projectContexts"
  | "projectHires"
  | "projectLiveReuse"
  | "projectPolicy"
  | "remoteSeatAdapters"
  | "remoteWorkspace"
  | "requireWorkerAccess"
  | "resolveModel"
  | "resumeInventory"
  | "retireReboundWatches"
  | "runner"
  | "save"
  | "seatAdapters"
  | "seatControl"
  | "skillBundle"
  | "startSeat"
  | "startupFailure"
  | "state"
  | "validateOwner"
  | "watchHiredSeat"
  | "workHires"
  | "workerAccounts"
  | "workerAccountsReport"
  | "workerSandbox"
>;

export function createHerdrWatchLaunch(ctx: Context) {
  async function resumeSeat(
    input: SpawnOperatorSeat,
    session: SavedAgentSession,
    brief?: string,
    receiptKey?: string,
    authority?: HireAuthority,
  ): Promise<HerdrSeatSpawnResult> {
    try {
      if (ctx.closed) throw new Error("Native hire service is closed");
      await ctx.commitRemoteLaunch(receiptKey, input);
      await ctx.assertRemoteHireAuthority(input, receiptKey, authority);
      if (authority !== undefined) {
        const held = ctx.hireOwners.sessionOwner(
          JSON.stringify([input.fleet ?? "local", input.harness, session.sessionId]),
        );
        if (held === undefined || held.conversationId !== authority.owner.conversationId)
          throw new Error(
            "Saved session has no matching persisted hiring conversation; inspection cannot claim ownership",
          );
      }
      const inventory = ctx.resumeInventory ?? ctx.runner.list?.bind(ctx.runner);
      if (inventory === undefined) throw new Error("Complete native seat inventory is unavailable");
      if (input.fleet !== undefined && !(await ctx.remoteWorkspace?.(input.fleet, input.workingDirectory)))
        return {
          outcome: "failed",
          reason: "unknown_directory",
          detail: "The saved session's directory is not granted on this fleet",
        };
      if (
        input.account !== undefined &&
        (input.fleet !== undefined || !["codex", "claude"].includes(input.harness))
      )
        throw new Error("Account overrides require a local Codex or Claude seat");
      if (input.account && input.harness === "claude") {
        const home = ((await ctx.claudeAccounts?.()) ?? []).find((a) => a.label === input.account)?.home;
        if (
          !home ||
          !session.file ||
          !(await realpath(session.file.path)).startsWith(`${await realpath(home)}/projects/`)
        )
          throw new Error("Saved Claude session belongs to a different or unregistered account profile");
      }
      const account =
        input.fleet === undefined && input.harness === "codex"
          ? await savedCodexAccount(session, await ctx.accounts(), input.account)
          : undefined;
      const live = existingNativeSession(await inventory(input.fleet), session);
      if (live !== undefined) {
        if (authority !== undefined) {
          const held = ctx.hireOwners.sessionOwner(ctx.nativeSessionKey(live) ?? "");
          if (held === undefined || held.conversationId !== authority.owner.conversationId)
            throw new Error("Saved live worker has no matching persisted conversation owner");
        }
        if (
          live.agent === "shell" ||
          live.agent === "unknown" ||
          live.status === "unknown" ||
          live.status === "offline"
        )
          throw new Error(`Pane ${live.paneId} has uncertain native identity; inspect it before resuming`);
        if (input.model !== undefined || input.effort !== undefined || input.chrome !== undefined)
          throw new Error(
            "The saved session is already live; its launch settings cannot be changed by resuming",
          );
        // History and Herdr metadata cannot restore a prepared controller after
        // disconnect/restart, including a resume with no initial message.
        const needsOriginalControl = session.source !== undefined || savedSessionHarness(session) === "pi";
        let control: SeatControl | undefined;
        let originalProof: ProjectHireProcessProof | undefined;
        const original = structuredClone(live);
        const verifyOriginal = async (): Promise<ProjectHireProcessProof | undefined> => {
          if (!needsOriginalControl) return undefined;
          if (ctx.closed || !control?.verify)
            throw new Error(
              "Original native controller verification is unavailable; no new seat was started",
            );
          const checkProof = async () => {
            if (
              control!.ref.paneId !== original.paneId ||
              control!.ref.harness !== input.harness ||
              control!.ref.sessionId !== session.sessionId
            )
              throw new Error("Original native controller reference changed");
            const proof = structuredClone(await control!.verify!());
            if (
              control!.ref.paneId !== original.paneId ||
              control!.ref.harness !== input.harness ||
              control!.ref.sessionId !== session.sessionId ||
              proof.pane !== original.paneId ||
              proof.fleet !== (input.fleet ?? "default") ||
              proof.nativeOccupantId !== occupantIdForHerdrSession(original.session!) ||
              (originalProof !== undefined && !isDeepStrictEqual(proof, originalProof))
            )
              throw new Error("Original native process identity changed");
            originalProof ??= proof;
            return proof;
          };
          await checkProof();
          // A matching UUID is not the saved native session: cwd and Pi's
          // independently resolved transcript address must also stay exact.
          const remoteOpenCode =
            session.host !== "local" &&
            session.source !== undefined &&
            input.harness === "opencode" &&
            input.fleet !== undefined &&
            session.source.machineId === session.host.id;
          if (!remoteOpenCode && (session.host !== "local" || input.fleet !== undefined))
            throw new Error("Prepared native saved-session reuse requires its original machine/controller");
          // Remote metadata was confined/canonicalized by the fresh SSH reader;
          // controller proof independently checks that machine's root cwd.
          const savedCwd = remoteOpenCode
            ? session.source!.workingDirectory
            : await realpath(session.workingDirectory);
          const savedPath = session.source === undefined ? await realpath(session.file.path) : undefined;
          const matchesSaved = (agent: HerdrAgentSnapshot) =>
            savedCwd === session.workingDirectory &&
            agent.workingDirectory === savedCwd &&
            (savedPath === undefined ||
              (savedPath === session.file!.path &&
                agent.session?.source === "herdr:pi" &&
                agent.session.kind === "path" &&
                agent.session.value === savedPath));
          const current = await ctx.runner.get(original.paneId);
          if (
            !matchesSaved(original) ||
            !matchesSaved(current) ||
            current.paneId !== original.paneId ||
            current.terminalId !== original.terminalId ||
            current.agent !== input.harness ||
            current.status === "offline" ||
            current.status === "unknown" ||
            current.workingDirectory !== original.workingDirectory ||
            !isDeepStrictEqual(current.session, original.session)
          )
            throw new Error("Original native pane/session changed while resuming");
          return checkProof();
        };
        const guardOriginal = async () => {
          await verifyOriginal();
          if (authority !== undefined) await assertConversationAuthority(authority);
          await verifyOriginal();
          if (needsOriginalControl) await ctx.admitProjectLaunch(input);
          return verifyOriginal();
        };
        if (needsOriginalControl) control = await ctx.seatControl.attach(original);
        const proof = await guardOriginal();
        await ctx.observeHireIdentity(receiptKey, original, input, authority, needsOriginalControl, proof);
        await verifyOriginal();
        // Reuse is allowed even at capacity. Never create another writer, or
        // turn a generic settlement of its current turn into this message's reply.
        if (brief !== undefined) {
          control ??= await ctx.seatControl.attach(live);
          if (!control)
            throw new Error(`The session is live in ${live.paneId}; message its existing seat explicitly`);
          if (receiptKey !== undefined) {
            const receipt = ctx.hireReceipts.pending(receiptKey)!;
            const before = await ctx.runner.transcript?.(live).catch(() => undefined);
            ctx.hireReceipts.update(receiptKey, receipt.messageId, {
              paneId: live.paneId,
              sessionId: nativeSessionId(live),
              ...(before === undefined ? {} : { beforeIds: before.entries.map((entry) => entry.id) }),
            });
          }
          await guardOriginal();
          const delivery = await control
            .send(brief)
            .catch((error: unknown) => ({ outcome: "unconfirmed" as const, detail: String(error) }));
          if (delivery.outcome !== "accepted")
            return {
              outcome: "failed",
              reason: delivery.outcome === "unconfirmed" ? "delivery_unconfirmed" : "not_ready",
              detail: `Existing pane ${live.paneId}: ${JSON.stringify(delivery)}; no new seat was started`,
            };
        }
        if (needsOriginalControl) {
          try {
            await guardOriginal();
          } catch (error) {
            if (brief === undefined) throw error;
            return {
              outcome: "failed",
              reason: "delivery_unconfirmed",
              detail:
                "Original native control changed after dispatch; inspect the existing session before retrying",
            };
          }
        }
        return spawnedSeat(
          live,
          live.paneId,
          live.name ?? live.terminalId,
          {
            ...input,
            title: live.title || input.title,
            workingDirectory: live.workingDirectory ?? input.workingDirectory,
          },
          account,
        );
      }
      return await ctx.startSeat(input, undefined, brief, session, receiptKey, authority);
    } catch (error) {
      return { outcome: "failed", reason: "not_ready", detail: reasonDetail(error) };
    }
  }

  async function observeHireIdentity(
    receiptKey: string | undefined,
    agent: HerdrAgentSnapshot,
    input: SpawnOperatorSeat,
    authority?: HireAuthority,
    requireProof = false,
    preparedProof?: ProjectHireProcessProof,
  ): Promise<void> {
    if (agent.session === undefined) throw new Error("Native hire identity has not been observed");
    const occupantId = occupantIdForHerdrSession(agent.session);
    const sessionId = nativeSessionId(agent);
    // Historical identity must survive channel/catalog readiness or process-proof failure.
    if (authority !== undefined) await ctx.bindHireOwner(agent, input, authority);
    if (receiptKey !== undefined) {
      const original = ctx.hireReceipts.pending(receiptKey)!;
      ctx.hireReceipts.update(receiptKey, original.messageId, {
        occupantId,
        ...(sessionId === undefined ? {} : { sessionId }),
      });
    }
    if (input.harness === "codex" && agent.workingDirectory !== ctx.nativeCheckout(input.workingDirectory))
      throw new Error("The seat cwd does not match the prepared checkout; startup is unconfirmed");
    const allocation = ctx.projectAllocations.get(input);
    if (allocation) {
      ctx.projectHires.pane(allocation, agent.paneId);
      const proof =
        preparedProof ??
        (await ctx.projectPolicy?.proof?.(input.fleet ?? "default", agent.paneId).catch(() => undefined));
      if (
        requireProof &&
        (!proof ||
          proof.nativeOccupantId !== occupantId ||
          proof.pane !== agent.paneId ||
          proof.fleet !== (input.fleet ?? "default"))
      ) {
        const refused =
          proof === undefined
            ? ctx.projectPolicy?.proofRefusal?.(agent.paneId)
            : proof.nativeOccupantId !== occupantId
              ? "occupant_mismatch"
              : proof.pane !== agent.paneId
                ? "pane_mismatch"
                : "fleet_mismatch";
        throw new Error(
          `Native hire binding has no matching current process proof${refused === undefined ? "" : ` (${refused})`}; delivery remains unconfirmed`,
        );
      }
      ctx.projectHires.observe(allocation, agent.terminalId, occupantId, proof);
    }
  }

  /**
   * Starts the seat, and states on its receipt which harness and account
   * Clankie chose for it and why, when the request left either open.
   */
  async function startSeat(
    input: SpawnOperatorSeat,
    subjectOverride?: string,
    brief?: string,
    resume?: SavedAgentSession,
    receiptKey?: string,
    authority?: HireAuthority,
  ): Promise<HerdrSeatSpawnResult> {
    const chosen: { account?: string; reason?: string } = {};
    let result = await ctx.launchSeat(input, chosen, subjectOverride, brief, resume, receiptKey, authority);
    const harnessReason = ctx.hireHarnessReasons.get(input);
    if (
      result.outcome !== "spawned" ||
      (harnessReason === undefined && chosen.reason === undefined && input.effortReason === undefined)
    )
      return result;
    const reason = [
      input.effortReason === undefined
        ? undefined
        : `model ${input.model ?? "native default"}; effort ${input.effort ?? "native default"}: ${input.effortReason}`,
      chosen.reason,
      harnessReason === undefined ? undefined : `${input.harness}: ${harnessReason}`,
    ]
      .filter((part): part is string => part !== undefined)
      .join(". ");
    return {
      ...result,
      accountChoice: {
        harness: input.harness,
        ...(chosen.account === undefined ? {} : { account: chosen.account }),
        reason: reason.slice(0, 1200),
      },
    };
  }

  async function launchSeat(
    input: SpawnOperatorSeat,
    chosen: { account?: string; reason?: string },
    subjectOverride?: string,
    brief?: string,
    resume?: SavedAgentSession,
    receiptKey?: string,
    authority?: HireAuthority,
  ): Promise<HerdrSeatSpawnResult> {
    if (ctx.projectLiveReuse.has(input))
      return {
        outcome: "failed",
        reason: "start_unconfirmed",
        detail: "The running agent changed before it could be reused. No replacement was started.",
      };
    const { createTab, startAgent } = ctx.runner;
    if (ctx.closed || createTab === undefined || startAgent === undefined) {
      return { outcome: "failed", reason: "herdr_unreachable" };
    }
    // A fresh hire past the body's limit is refused before anything starts. A
    // move re-hires a seat it has just closed under the same name, so it is
    // not a new agent and is never refused for capacity.
    if (subjectOverride === undefined) {
      const capacity = await ctx.hireCapacity?.().catch(() => undefined);
      if (capacity !== undefined && capacity.live >= capacity.limit) {
        return {
          outcome: "failed",
          reason: "at_capacity",
          detail: `${String(capacity.live)} of ${String(capacity.limit)} hired agents are running on this Clankie; close one before hiring another.`,
        };
      }
    }
    const remote = input.fleet;
    if (remote === undefined) {
      // The captain runs on the machine herdr does, so this is the real check —
      // and a missing path is the one failure worth naming precisely, because it
      // is the one the operator can fix from the compose page.
      if (!existsSync(input.workingDirectory)) {
        return { outcome: "failed", reason: "unknown_directory", detail: input.workingDirectory };
      }
    } else if (!(await ctx.remoteWorkspace?.(remote, input.workingDirectory).catch(() => false))) {
      // Another machine's directories are the owner's grant, not a stat from here.
      return {
        outcome: "failed",
        reason: "unknown_directory",
        detail: `${input.workingDirectory} is not a granted workspace on fleet ${remote}; add it, keeping the other grants, with clankie runtime workspaces ${remote} --dir '${input.workingDirectory}'`,
      };
    }
    const adapters = remote === undefined ? ctx.seatAdapters : ctx.remoteSeatAdapters?.(remote);
    const candidate =
      input.harness === "pi" &&
      (remote === undefined || remote === HERDR_CORE_FLEET) &&
      ctx.piNativeEnabled &&
      !(await ctx.piNativeEnabled())
        ? undefined
        : adapters?.get(input.harness);
    const adapter =
      (brief !== undefined || resume !== undefined || candidate?.prepare !== undefined) &&
      (candidate?.prepare !== undefined || ctx.runner.runInPane !== undefined)
        ? candidate
        : undefined;
    const unavailableReason =
      remote !== undefined && adapters?.get(input.harness) === undefined
        ? "remote_fleet"
        : ctx.runner.runInPane === undefined
          ? "pane_run_unavailable"
          : "adapter_unavailable";
    if (
      (brief !== undefined ||
        input.harness === "opencode" ||
        input.harness === "grok" ||
        input.harness === "prime") &&
      adapter === undefined
    ) {
      const detail = `No structured harness adapter is available (${unavailableReason}); no seat was started and no terminal input was sent.`;
      return {
        outcome: "failed",
        reason: "harness_unavailable",
        detail,
        control: { mode: "unavailable", reason: unavailableReason, detail },
      };
    }
    if (
      resume === undefined &&
      ctx.workHires.has(input) &&
      ((!authority?.ownerHire && (!input.effort || input.effort === HIRE_NO_PREFERENCE)) ||
        !input.effortReason)
    )
      return {
        outcome: "failed",
        reason: "not_ready",
        detail:
          "Choose effort for this job and give effortReason: why it is the smallest effort that meets acceptance. Fleet-wide effort is retired.",
      };
    let admittedAccount: string | undefined;
    const recheckPlan = async (allowUsageOverride = true, restarting = false): Promise<void> => {
      if (
        (!restarting && (resume !== undefined || !ctx.workHires.has(input))) ||
        (input.harness !== "claude" && input.harness !== "codex")
      )
        return;
      if (!ctx.workerAccountsReport)
        throw new Error("Observed plan usage is required before a new work hire.");
      const context = ctx.projectContexts.get(input);
      const settings = await ctx.projectPolicy?.settings();
      const policy = settings?.projects.find((project) => project.id === context?.projectId)?.hiring;
      const report = await ctx.workerAccountsReport(input.fleet);
      if ((policy?.excludedModels?.length || policy?.allowedModels) && !input.model)
        throw new Error("Choose an explicit model so the project's model constraints can be checked.");
      const requestedModels = [input.model, input.subagents?.model].filter(
        (model): model is string => model !== undefined,
      );
      const models = await Promise.all(
        requestedModels.map((model) => (ctx.resolveModel ? ctx.resolveModel(input.harness, model) : model)),
      );
      const eligible = hireAdmissionReport(
        report,
        policy,
        models,
        Date.now(),
        allowUsageOverride && authority?.ownerHire?.overrideUsage === true,
      );
      // Fresh replacement is new work even when the original hire resumed history.
      // Its existing account is fixed; spare capacity elsewhere never selects a replacement identity.
      const pinnedAccount = restarting
        ? (identityAccount?.accountKey ??
          identityAccount?.label ??
          account?.label ??
          admittedAccount ??
          input.account)
        : (admittedAccount ?? input.account);
      if (restarting && pinnedAccount === undefined)
        throw new Error("Original account identity unavailable for restart plan admission");
      const selection = hireAdmissionChoice(eligible, input.harness, pinnedAccount);
      // Pin the verified eligible identity; later identity/grant checks still apply.
      admittedAccount = selection.account.accountKey ?? selection.account.label;
      chosen.account = admittedAccount;
      chosen.reason = `${selection.plan}; ${Math.round(selection.remaining * 100)}% remaining at ${selection.account.usage!.observedAt}; ${selection.reason}${allowUsageOverride && authority?.ownerHire?.overrideUsage ? "; owner explicitly overrode the new-hire usage reserve" : ""}`;
      const allocation = ctx.projectAllocations.get(input);
      if (allocation)
        ctx.projectHires.selection(allocation, {
          at: selection.account.usage!.observedAt,
          plan: selection.plan,
          remaining: selection.remaining,
          reason: `${selection.reason}${allowUsageOverride && authority?.ownerHire?.overrideUsage ? "; owner explicitly overrode the new-hire usage reserve" : ""}`,
          model: models[0] ?? "native default",
          effort: input.effort ?? "native default",
          effortReason: input.effortReason!,
        });
    };
    try {
      await recheckPlan();
    } catch (error) {
      return {
        outcome: "failed",
        reason: "harness_unavailable",
        detail: reasonDetail(error),
        ...(authority?.ownerHire && error instanceof HireAdmissionError
          ? { admission: error.admission }
          : {}),
      };
    }
    // Resolve a preference to an identity before preparing any native launch.
    // The chosen home is replaceable; the requested identity is not.
    let identityAccount: import("./harness-accounts.ts").WorkerAccountStatus | undefined;
    const identityHarness =
      input.harness === "claude" || input.harness === "codex" ? input.harness : undefined;
    if (
      resume === undefined &&
      identityHarness &&
      ctx.workerAccounts &&
      ctx.nativeLaunchPolicy?.prepare === undefined
    ) {
      const report = await ctx.workerAccounts(remote, identityHarness).catch(() => undefined);
      if (!report)
        return {
          outcome: "failed",
          reason: "harness_unavailable",
          detail: "Could not verify the requested sign-in; no account was tried.",
        };
      const choice = chooseWorkerAccount(
        remote ?? "this Mac",
        identityHarness,
        report,
        admittedAccount ?? input.account,
      );
      if ("refused" in choice)
        return { outcome: "failed", reason: "harness_unavailable", detail: choice.refused };
      identityAccount = choice.account;
      if (input.account === undefined) {
        chosen.account = choice.account.label;
        chosen.reason ??= `${choice.account.identity ?? choice.account.displayName ?? choice.account.harness}: ${choice.why}`;
      }
    } else if (
      resume !== undefined &&
      !resume.source &&
      identityHarness === "claude" &&
      remote === undefined &&
      ctx.workerAccounts &&
      ctx.nativeLaunchPolicy?.prepare === undefined
    ) {
      // A saved Claude session resumes only in the profile home that holds it (LOCAL-VUH-31).
      try {
        const report = await ctx.workerAccounts(remote, identityHarness);
        identityAccount = await savedClaudeAccount(resume, report.accounts, admittedAccount ?? input.account);
      } catch (error) {
        return { outcome: "failed", reason: "harness_unavailable", detail: reasonDetail(error) };
      }
      if (input.account === undefined) {
        chosen.account = identityAccount.label;
        chosen.reason ??= "the saved session's own Claude profile";
      }
    }
    if (ctx.nativeLaunchPolicy?.prepare) {
      await recheckPlan();
      await ctx.admitProjectLaunch(input, true);
      await ctx.commitRemoteLaunch(receiptKey, input);
      await ctx.assertRemoteHireAuthority(input, receiptKey, authority);
    }
    const prepared = await ctx.nativeLaunchPolicy?.prepare?.({
      seat: {
        ...structuredClone(input),
        ...(admittedAccount === undefined ? {} : { account: admittedAccount }),
      },
      resumed: resume !== undefined,
    });
    let account: CodexAccount | undefined =
      identityAccount && identityHarness === "codex"
        ? { label: identityAccount.label, home: identityAccount.home }
        : prepared?.account;
    const accountHarness =
      input.harness === "codex" || input.harness === "claude" ? input.harness : undefined;
    if (input.account !== undefined && accountHarness === undefined) {
      return {
        outcome: "failed",
        reason: "harness_unavailable",
        detail: "Account overrides apply to Codex and Claude hires only.",
      };
    }
    if (
      prepared === undefined &&
      remote !== undefined &&
      accountHarness &&
      input.account !== undefined &&
      !identityAccount
    )
      return {
        outcome: "failed",
        reason: "harness_unavailable",
        detail:
          resume !== undefined
            ? "A resumed remote session keeps its saved home; omit account."
            : `Account discovery on ${remote} is unavailable; no account was tried.`,
      };
    let remoteAccountEnv: Record<string, string> | undefined;
    let claudeHome: string | undefined;
    let claudeLabel = input.account;
    // Launch the home exactly as the account probe read it. Setting
    // CLAUDE_CONFIG_DIR, even to the default home, selects a separately keyed
    // keychain credential the probe never checked (VUH-2241).
    const identityEnv =
      identityAccount === undefined ||
      (identityHarness === "claude" && identityAccount.nativeDefault === true)
        ? undefined
        : { [identityHarness === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: identityAccount.home };
    if (identityAccount) {
      if (remote !== undefined) remoteAccountEnv = identityEnv;
      else if (identityHarness === "claude") {
        const home = await realpath(identityAccount.home).catch(() => undefined);
        claudeLabel = identityAccount.label;
        if (!home)
          return {
            outcome: "failed",
            reason: "harness_unavailable",
            detail:
              "The selected identity's home is unavailable; sign in to that account again. No other account was tried.",
          };
        if (identityEnv !== undefined) claudeHome = home;
      }
    } else if (prepared === undefined && remote === undefined && input.harness === "codex") {
      // Legacy adapters without account discovery still support saved sessions.
      try {
        const accounts = await ctx.accounts();
        const held = ((await ctx.accountHolds?.().catch(() => [])) ?? [])
          .filter((hold) => hold.machine === "local" && hold.harness === "codex")
          .map((hold) => hold.label);
        const selected =
          resume === undefined
            ? await selectLiveCodexAccount(accounts, input.account, held)
            : await savedCodexAccount(resume, accounts, input.account);
        account = { label: selected.label, home: selected.home };
      } catch (error) {
        return { outcome: "failed", reason: "harness_unavailable", detail: reasonDetail(error) };
      }
    } else if (input.harness === "claude" && claudeLabel && remote === undefined) {
      const selected = ((await ctx.claudeAccounts?.()) ?? []).find((a) => a.label === claudeLabel);
      if (!selected)
        return {
          outcome: "failed",
          reason: "harness_unavailable",
          detail: `No home is signed into Claude account ${claudeLabel}; sign in to the intended account. No other account was tried.`,
        };
      claudeHome = await realpath(selected.home).catch(() => undefined);
      if (!claudeHome)
        return {
          outcome: "failed",
          reason: "harness_unavailable",
          detail: "Claude profile home is unavailable; no account fallback was attempted.",
        };
    }
    // A local hire starts only the owner MCP servers its profile opts in, beside
    // Clankie's worker bridge and its checkout's own (VUH-2388). A remote
    // machine's configuration is read there and stays unchanged.
    const workerMcp = remote === undefined ? { mcpServers: input.mcpServers ?? [] } : {};
    let paneId: string;
    let nativePrepared: PreparedSeatLaunch | undefined;
    let nativeLaunch: SeatLaunch | undefined;
    let startupTools: readonly string[] | undefined;
    let sandbox: WorkerSandbox | undefined;
    let skillLaunch: Awaited<ReturnType<typeof workerSkills>> = prepared ?? {
      args: [],
      ...(remote !== undefined
        ? remoteAccountEnv === undefined
          ? {}
          : { env: remoteAccountEnv }
        : account
          ? { env: { CODEX_HOME: account.home } }
          : {}),
    };
    if (identityEnv !== undefined)
      skillLaunch = { ...skillLaunch, env: { ...skillLaunch.env, ...identityEnv } };
    try {
      if (prepared === undefined && remote === undefined && ctx.skillBundle !== undefined) {
        skillLaunch = await workerSkills(
          input.harness,
          ctx.skillBundle.repoRoot,
          ctx.skillBundle.stateDir,
          account?.home,
          input.workingDirectory,
        );
      }
      if (claudeHome)
        skillLaunch = { ...skillLaunch, env: { ...skillLaunch.env, CLAUDE_CONFIG_DIR: claudeHome } };
      // The native environment wins over saved per-model windows (ADR 0293).
      // This is a new hire's launch only, never the lead or an existing pane.
      if (input.harness === "claude")
        skillLaunch = {
          ...skillLaunch,
          env: { ...skillLaunch.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000" },
        };
      if (input.placement === "split" && !input.pipeline)
        throw new Error("Split placement requires a named pipeline; provide pipeline or choose new-tab.");
      // External Herdr panes inherit the server's environment, not this
      // service's. Carry its discovery namespace explicitly for local hires.
      // Trusted preallocation owns its complete environment; SSH fleets use
      // their own machine's state and must never receive this local path.
      if (prepared === undefined && remote === undefined) {
        skillLaunch = {
          ...skillLaunch,
          env: {
            ...skillLaunch.env,
            CLANKIE_STATE: resolve(process.env.CLANKIE_STATE?.trim() || join(homedir(), ".clankie")),
            // A hire never holds the owner's bearers (VUH-2592), even if Herdr's server did.
            ...WORKER_PANE_ENV,
          },
        };
        sandbox = await ctx.workerSandbox?.();
        if (sandbox) skillLaunch = { ...skillLaunch, env: { ...skillLaunch.env, ...sandbox.env } };
      }
      startupTools = ["claude", "codex"].includes(input.harness)
        ? await ctx.expectedHireTools(input)
        : undefined;
      if (startupTools !== undefined)
        skillLaunch = {
          ...skillLaunch,
          env: { ...skillLaunch.env, CLANKIE_EXPECTED_TOOL_NAMES: JSON.stringify(startupTools) },
        };
      await ctx.nativeLaunchPolicy?.admit({
        seat: structuredClone(input),
        phase: "launch",
        ...(account === undefined ? {} : { account: { ...account } }),
        resumed: resume !== undefined,
      });
      if (authority !== undefined) await assertConversationAuthority(authority);
      await ctx.admitProjectLaunch(input);
      await ctx.commitRemoteLaunch(receiptKey, input);
      await ctx.assertRemoteHireAuthority(input, receiptKey, authority);
      if (adapter?.prepare) {
        if (input.chrome) throw new Error(`${input.harness} has no supported Chrome launch option`);
        const requestedModel =
          input.model === undefined || !ctx.resolveModel
            ? input.model
            : await ctx.resolveModel(input.harness, input.model);
        const model = input.harness === "pi" ? await ctx.hostedPiModel(requestedModel) : requestedModel;
        const allocation = ctx.projectAllocations.get(input);
        const required = allocation === undefined ? undefined : ctx.projectHires.requiredModel(allocation);
        if (
          required !== undefined &&
          model !== (ctx.resolveModel ? await ctx.resolveModel(input.harness, required) : required)
        )
          throw new Error("This role's required model is unavailable");
        nativeLaunch = {
          harness: adapter.harness,
          cwd: input.workingDirectory,
          brief: brief ?? "",
          ...(resume === undefined ? {} : { resumeSessionId: resume.sessionId }),
          ...(model === undefined ? {} : { model }),
          ...(input.effort === undefined ? {} : { effort: input.effort }),
          ...(skillLaunch.env === undefined ? {} : { env: skillLaunch.env }),
          harnessArgs: skillLaunch.args,
          ...(input.readOnly === true
            ? { readOnly: true }
            : (await ctx.maximumTrustMode?.()) === true
              ? { maximumTrust: true }
              : {}),
          ...workerMcp,
        };
        await ctx.assertRemoteHireAuthority(input, receiptKey, authority);
        nativePrepared = await adapter.prepare(nativeLaunch);
        if (authority !== undefined) await assertConversationAuthority(authority);
        await ctx.admitProjectLaunch(input);
      }
      if (claudeHome && !identityAccount) {
        const current = ((await ctx.claudeAccounts?.()) ?? []).find((a) => a.label === claudeLabel);
        if (!current || (await realpath(current.home).catch(() => undefined)) !== claudeHome)
          throw new Error("Claude account profile changed during startup");
      }
      await ctx.assertRemoteHireAuthority(input, receiptKey, authority);
      // Prepared adapters can await account, process and private-state setup.
      // Pressure is re-read after those awaits, immediately before the pane
      // command can create its native process.
      if (ctx.fleetResources) await ctx.admitResourceMutation(input, authority);
      await recheckPlan();
      await ctx.admitProjectLaunch(input, true);
      if (identityAccount && identityHarness && ctx.workerAccounts) {
        // Only a read that contradicts the choice refuses. A probe that didn't answer, or a
        // home whose own read timed out, says nothing about its sign-in (#326): look once
        // more, then launch on the identity verified moments ago.
        const reread = async () =>
          startupSignIn(
            // allow-swallowed-rejection -- a failed re-read is no evidence of a sign-in change.
            await ctx.workerAccounts!(remote, identityHarness).catch(() => undefined),
            identityAccount!,
          );
        let verdict = await reread();
        if (verdict === "unknown") verdict = await reread();
        if (verdict === "changed")
          throw new Error(
            "The selected home changed sign-in during startup; no agent was started. Select the intended account again.",
          );
      }
      if (authority !== undefined) await assertConversationAuthority(authority);
      const project = ctx.projectContexts.get(input)?.projectName;
      const group = project ?? input.deliverable;
      paneId = await createTab({
        ...(group === undefined ? {} : { group }),
        ...(project === undefined ? {} : { project }),
        ...(input.pipeline === undefined ? {} : { pipeline: input.pipeline }),
        ...(input.placement === undefined ? {} : { placement: input.placement }),
        cwd: input.workingDirectory,
        harness: input.harness,
        label: hirePaneLabel(input.title, input.taskTitle, input.role),
        ...(resume === undefined ? {} : { paneLabel: resumePaneLabel(resume) }),
        ...(nativePrepared === undefined
          ? skillLaunch.env === undefined && sandbox === undefined
            ? {}
            : { env: { ...skillLaunch.env, ...sandbox?.shellEnv } }
          : {
              command: sandbox ? sandbox.wrap(nativePrepared.command) : nativePrepared.command,
              env: { ...skillLaunch.env, ...nativePrepared.env },
            }),
        ...(remote === undefined ? {} : { fleet: remote }),
      });
    } catch (caught) {
      await nativePrepared?.dispose();
      if (remote === undefined && caught instanceof HireLayoutNotStarted) {
        const allocation = ctx.projectAllocations.get(input);
        if (allocation) ctx.projectHires.notStarted(allocation);
      }
      // Only the workspace create went unanswered: no harness command left this
      // service and nothing prepared ran first, so the PC's journal may seal it (#326).
      if (
        caught instanceof HireLayoutUnconfirmed &&
        caught.commandUnsent &&
        caught.paneId === undefined &&
        remote !== undefined &&
        nativePrepared === undefined &&
        prepared === undefined &&
        receiptKey !== undefined
      ) {
        const receipt = ctx.hireReceipts.pending(receiptKey);
        if (receipt?.remoteLaunchCommitted && !receipt.paneId)
          ctx.hireReceipts.update(receiptKey, receipt.messageId, { remoteCommandUnsent: true });
      }
      if (caught instanceof HireLayoutUnconfirmed && caught.paneId) {
        const pane = remote === undefined ? caught.paneId : `${remote}/${caught.paneId}`;
        if (receiptKey !== undefined) {
          const receipt = ctx.hireReceipts.pending(receiptKey)!;
          ctx.hireReceipts.update(receiptKey, receipt.messageId, { paneId: pane });
        }
        const allocation = ctx.projectAllocations.get(input);
        if (allocation) ctx.projectHires.pane(allocation, pane);
        if (authority !== undefined)
          ctx.hireOwners.bind(pane, authority.owner, undefined, authority.intentId);
      }
      return {
        outcome: "failed",
        reason:
          caught instanceof ResourceAdmissionError
            ? "not_ready"
            : caught instanceof HireLayoutUnconfirmed
              ? "start_unconfirmed"
              : adapter?.prepare
                ? "harness_unavailable"
                : "herdr_unreachable",
        detail: reasonDetail(caught),
      };
    }
    const projectAllocation = ctx.projectAllocations.get(input);
    const labelConfirmedResume = async (agent: HerdrAgentSnapshot) => {
      if (resume === undefined || ctx.runner.renamePane === undefined) return;
      const current = await ctx.runner.get(paneId);
      if (current.terminalId !== agent.terminalId || nativeSessionId(current) !== resume.sessionId)
        throw new Error("Resumed pane changed before its label was confirmed");
      if (authority !== undefined) await assertConversationAuthority(authority);
      await ctx.runner.renamePane(paneId, hirePaneLabel(input.title, input.taskTitle, input.role));
    };
    let control: SeatControlMode | undefined;
    let startAttempted = nativePrepared !== undefined;
    try {
      if (nativePrepared) {
        ctx.state.preparedPanes ??= [];
        if (!ctx.state.preparedPanes.some((entry) => entry.paneId === paneId)) {
          ctx.state.preparedPanes.push({ paneId });
          ctx.save();
        }
      }
      if (projectAllocation) ctx.projectHires.pane(projectAllocation, paneId);
      if (authority !== undefined)
        ctx.hireOwners.bind(paneId, authority.owner, undefined, authority.intentId);
      // A pi seat's durable identity is the session its herdr extension
      // reports; make sure the extension is there before starting one.
      if (input.harness === "pi" && remote === undefined && nativePrepared === undefined)
        await ctx.runner.installPiIntegration?.();
      const subject = subjectOverride ?? herdrAgentName(input.title);
      if (receiptKey !== undefined) {
        const receipt = ctx.hireReceipts.pending(receiptKey)!;
        ctx.hireReceipts.update(receiptKey, receipt.messageId, { paneId, agentName: subject });
      }
      if (authority?.onHirePane !== undefined) {
        // A pending receipt names the seat by the same terminal ID `started` and list_agents use;
        // a pane ID is only a layout address.
        const allocated = await ctx.runner.get(paneId).catch(() => undefined);
        if (allocated !== undefined) authority.onHirePane(allocated.terminalId);
      }
      const requestedModel =
        nativePrepared !== undefined
          ? nativeLaunch?.model
          : input.model === undefined || !ctx.resolveModel
            ? input.model
            : await ctx.resolveModel(input.harness, input.model);
      const model =
        nativePrepared !== undefined
          ? nativeLaunch?.model
          : input.harness === "pi"
            ? await ctx.hostedPiModel(requestedModel)
            : requestedModel;
      const requiredModel =
        projectAllocation === undefined ? undefined : ctx.projectHires.requiredModel(projectAllocation);
      if (
        requiredModel !== undefined &&
        model !== (ctx.resolveModel ? await ctx.resolveModel(input.harness, requiredModel) : requiredModel)
      )
        throw new Error(
          "This role's model is not available on this machine. Choose an available model in the project settings.",
        );
      // A model or effort the harness cannot take fails the hire typed, before
      // herdr is asked to start anything — the alternative is a hire that
      // silently launches the default the operator did not pick (ADR 0185).
      const modelArgs =
        model === undefined || nativePrepared !== undefined ? [] : fleetSeatModelArgs(input.harness, model);
      if (modelArgs === undefined) throw new Error(`unsupported: ${input.harness} has no wired model flag`);
      const effortArgs =
        input.effort === undefined || nativePrepared !== undefined
          ? []
          : fleetSeatEffortArgs(input.harness, input.effort);
      if (effortArgs === undefined) throw new Error(`unsupported: ${input.harness} has no wired effort flag`);
      const chromeArgs = input.chrome === true ? fleetSeatChromeArgs(input.harness) : [];
      if (chromeArgs === undefined)
        throw new Error(`unsupported: ${input.harness} has no Chrome integration`);
      const terminalReason =
        remote !== undefined && adapter === undefined
          ? "remote_fleet"
          : brief === undefined
            ? "no_brief"
            : ctx.runner.runInPane === undefined
              ? "pane_run_unavailable"
              : "adapter_unavailable";
      control =
        adapter === undefined
          ? {
              mode: "terminal",
              reason: terminalReason,
              detail: `No harness adapter selected: ${terminalReason}.`,
            }
          : { mode: input.harness === "claude" ? "channel" : "adapter" };
      // Typed into a bare terminal, a hire would start in the harness's everyday mode.
      if (input.readOnly === true && (adapter?.harness !== "claude" || brief === undefined))
        throw new Error("A read-only hire needs Claude's own seat adapter and a brief");
      if (authority !== undefined) await assertConversationAuthority(authority);
      if (
        adapter !== undefined &&
        (brief !== undefined || resume !== undefined || nativePrepared !== undefined)
      ) {
        const runInPane = ctx.runner.runInPane!;
        const expectedToolNames = ["claude", "codex"].includes(adapter.harness) ? startupTools : undefined;
        const checkExpectedTools = async () => {
          if (
            expectedToolNames !== undefined &&
            JSON.stringify(await ctx.expectedHireTools(input)) !== JSON.stringify(expectedToolNames)
          )
            throw new Error("Project granted tools changed during native startup; no brief was sent");
        };
        startAttempted = true;
        const launchView: SeatView = {
          paneId,
          ...(authority?.onHirePane === undefined ? {} : { waitForStartup: true }),
          name: subject,
          ...(expectedToolNames === undefined ? {} : { expectedToolNames }),
          guard: async () => {
            if (authority !== undefined) await assertConversationAuthority(authority);
            await ctx.admitProjectLaunch(input);
            await checkExpectedTools();
          },
          question: (ref, question) => ctx.forwardNativeQuestion(ref, question),
          bound: async (ref) => {
            if (ref.paneId !== paneId || ref.harness !== input.harness || !ref.sessionId)
              throw new Error("Native hire binding does not match the allocated pane and harness");
            const agent = await ctx.agentWithSession(paneId, SPAWN_SESSION_WAIT_MS);
            const matches = (current: HerdrAgentSnapshot) =>
              current.paneId === paneId &&
              current.agent === ref.harness &&
              (ref.harness !== "codex" ||
                current.workingDirectory === ctx.nativeCheckout(input.workingDirectory)) &&
              current.status !== "offline" &&
              current.status !== "unknown" &&
              nativeSessionId(current) === ref.sessionId;
            if (!matches(agent)) throw new Error("Native hire binding does not match the live session");
            const nativeProof = await nativePrepared?.verify(ref);
            if (nativePrepared) {
              const allocated = ctx.state.preparedPanes?.find((entry) => entry.paneId === paneId);
              if (!allocated) throw new Error("Prepared native allocation record unavailable");
              allocated.terminalId = agent.terminalId;
              ctx.save();
            }
            await ctx.observeHireIdentity(receiptKey, agent, input, authority, true, nativeProof);
            if (authority !== undefined) await assertConversationAuthority(authority);
            await ctx.admitProjectLaunch(input);
            const currentToolNames = await ctx.expectedHireTools(input);
            await checkExpectedTools();
            const final = await ctx.runner.get(paneId);
            if (!matches(final) || final.terminalId !== agent.terminalId)
              throw new Error("Native hire changed while binding; no brief was sent");
            if (authority !== undefined) await assertConversationAuthority(authority);
            await ctx.admitProjectLaunch(input);
            if (nativePrepared) {
              const finalProof = await nativePrepared.verify(ref);
              await ctx.observeHireIdentity(receiptKey, final, input, authority, true, finalProof);
            }
            return { expectedToolNames: currentToolNames };
          },
          run: async (argv) => {
            if (authority !== undefined) await assertConversationAuthority(authority);
            await ctx.admitProjectLaunch(input);
            if (nativePrepared || !runInPane)
              throw new Error("Prepared native launch has no terminal input fallback");
            if (ctx.fleetResources) await ctx.admitResourceMutation(input, authority);
            return runInPane(paneId, argv);
          },
          start: async (harness, argv) => {
            if (authority !== undefined) await assertConversationAuthority(authority);
            await ctx.admitProjectLaunch(input);
            if (nativePrepared) throw new Error("Prepared native launch cannot start a second process");
            if (ctx.fleetResources) await ctx.admitResourceMutation(input, authority);
            return startAgent({
              name: subject,
              kind: harness,
              paneId,
              ...(argv.length === 0 ? {} : { args: argv }),
            });
          },
        };
        const effectiveLaunch: SeatLaunch = nativeLaunch ?? {
          harness: adapter.harness,
          cwd: input.workingDirectory,
          brief: brief ?? "",
          ...(resume === undefined ? {} : { resumeSessionId: resume.sessionId }),
          ...(model === undefined ? {} : { model }),
          ...(input.effort === undefined ? {} : { effort: input.effort }),
          ...(skillLaunch.env === undefined ? {} : { env: { ...skillLaunch.env } }),
          harnessArgs: [...skillLaunch.args, ...chromeArgs],
          ...(input.readOnly === true
            ? { readOnly: true }
            : (await ctx.maximumTrustMode?.()) === true
              ? { maximumTrust: true }
              : {}),
          ...workerMcp,
        };
        // Pin the canonical profile at original hire time, not at the later restart.
        // A missing signed-in identity leaves this hire usable but automatic restart refused.
        const restartAccountHome = identityAccount
          ? // allow-swallowed-rejection -- a missing canonical home leaves automatic restart unavailable; it cannot authorize an exit.
            await realpath(identityAccount.home).catch(() => undefined)
          : undefined;
        const started = nativePrepared
          ? await nativePrepared.start(launchView)
          : await adapter.start(effectiveLaunch, launchView);
        if (started.outcome === "failed") {
          await nativePrepared?.dispose();
          const failure = await ctx.startupFailure(paneId, input.harness, started.detail, started.reason);
          if (started.reason === "harness_unavailable" && !nativePrepared) {
            await ctx.runner.closePane?.(paneId).catch(() => undefined);
            return { ...failure, control };
          }
          return {
            ...failure,
            ...(started.briefDelivery === "not_sent" ? { briefDelivery: "not_sent" as const } : {}),
            reason:
              failure.reason === "trust_required"
                ? "trust_required"
                : started.briefDelivery === "not_sent"
                  ? "not_ready"
                  : started.detail.includes("brief_delivery_unverified")
                    ? "delivery_unconfirmed"
                    : "start_unconfirmed",
            control,
            detail: `${failure.detail ?? started.detail}; inspect pane ${paneId}; no fallback was started`,
          };
        }
        if (started.outcome === "started") {
          const ref = started.control.ref;
          if (
            authority !== undefined &&
            (ref === undefined || ref.paneId !== paneId || ref.harness !== input.harness)
          )
            throw new Error("Native hire result has no exact original adapter binding");
          if (
            ref !== undefined &&
            ref.paneId === paneId &&
            ref.harness === input.harness &&
            receiptKey !== undefined
          ) {
            const original = ctx.hireReceipts.pending(receiptKey)!;
            ctx.hireReceipts.update(receiptKey, original.messageId, { sessionId: ref.sessionId });
          }
          const agent = await ctx.agentWithSession(paneId, SPAWN_SESSION_WAIT_MS);
          if (agent.session === undefined)
            throw new Error("The seat started without reporting its session to herdr");
          if (resume !== undefined && nativeSessionId(agent) !== resume.sessionId)
            throw new Error("The seat reported a different session after resumption");
          if (
            authority !== undefined &&
            (started.control.ref.paneId !== paneId ||
              started.control.ref.sessionId !== nativeSessionId(agent))
          )
            throw new Error("Native hire result does not match its original adapter session");
          const finalNativeProof = await nativePrepared?.verify(started.control.ref);
          await ctx.observeHireIdentity(
            receiptKey,
            agent,
            input,
            authority,
            nativePrepared !== undefined,
            finalNativeProof,
          );
          await labelConfirmedResume(agent);
          if (
            remote === undefined &&
            authority !== undefined &&
            ["claude", "codex"].includes(input.harness)
          ) {
            const observed: ProjectHireProcessProof | undefined =
              finalNativeProof ?? (await ctx.projectPolicy?.proof?.("default", paneId));
            const proof =
              observed && !observed.nativeSessionPending
                ? (ProjectHireProcessProofSchema.parse({
                    nativeOccupantId: observed.nativeOccupantId,
                    fleet: observed.fleet,
                    pane: observed.pane,
                    binding: observed.binding,
                    processes: observed.processes,
                    shell: observed.shell,
                  }) as ProjectHireProcessProof)
                : undefined;
            let restartAgent = agent;
            const restartAuthority: ConversationAuthority = {
              owner: authority.owner,
              current: () => !ctx.closed,
              authorize: async () => (await ctx.validateOwner?.(authority.owner)) === true,
            };
            const restartRevocation = async () => {
              await assertConversationAuthority(restartAuthority);
              if (effectiveLaunch.maximumTrust === true && (await ctx.maximumTrustMode?.()) !== true)
                throw new Error("Original hire maximum trust revoked");
              const currentClaim = restartAgent.session
                ? ctx.hireOwners.claim(
                    paneId,
                    restartAgent.terminalId,
                    occupantIdForHerdrSession(restartAgent.session),
                  )
                : undefined;
              if (!currentClaim?.hired || !isDeepStrictEqual(currentClaim.owner, authority.owner))
                throw new Error("Original persisted hire owner changed");
              await ctx.requireWorkerAccess?.(input.fleet);
              const context = ctx.projectContexts.get(input);
              if (context && ctx.projectPolicy) {
                const settings = await ctx.projectPolicy.settings();
                const project = await ctx.projectPolicy.project(input, settings, restartAuthority);
                if (project !== context.projectId) throw new Error("Original hire project access revoked");
              }
              // Losing a previously granted tool is revocation; additional tools do not
              // change this successor's pinned startup catalog.
              if (expectedToolNames !== undefined) {
                const current = new Set(await ctx.expectedHireTools(input));
                if (expectedToolNames.some((name) => !current.has(name)))
                  throw new Error("Original hire tool access revoked");
              }
              await assertConversationAuthority(restartAuthority);
            };
            const restartFreshness = async () => {
              if (((await ctx.maximumTrustMode?.()) === true) !== (effectiveLaunch.maximumTrust === true))
                throw new Error("Original hire maximum trust changed");
              if (
                !identityAccount ||
                !identityHarness ||
                !ctx.workerAccounts ||
                !restartAccountHome ||
                identityAccount.signedIn !== true ||
                !identityAccount.accountKey ||
                !(identityAccount.identity || identityAccount.identityId || identityAccount.chatgptAccountId)
              )
                throw new Error("Original signed-in account identity unavailable for restart");
              const current = await ctx.workerAccounts(remote, identityHarness);
              const signed = current.accounts.find(
                (entry) =>
                  entry.harness === identityHarness &&
                  entry.signedIn === true &&
                  entry.accountKey === identityAccount.accountKey &&
                  entry.label === identityAccount.label &&
                  entry.identity === identityAccount.identity &&
                  entry.identityId === identityAccount.identityId &&
                  entry.organizationId === identityAccount.organizationId &&
                  entry.chatgptAccountId === identityAccount.chatgptAccountId &&
                  entry.nativeDefault === identityAccount.nativeDefault &&
                  (entry.homes ?? [{ home: entry.home }]).some(({ home }) => home === identityAccount.home),
              );
              if (!signed || (await realpath(identityAccount.home)) !== restartAccountHome)
                throw new Error("Original signed-in account identity or home changed before restart");
            };
            const admitRestart = async () => {
              await restartRevocation();
              const restartPolicySeat = structuredClone(input);
              if (restartPolicySeat.ownerWork) delete restartPolicySeat.ownerWork.overrideUsage;
              await ctx.nativeLaunchPolicy?.admit({
                seat: restartPolicySeat,
                phase: "launch",
                ...(account === undefined ? {} : { account: { ...account } }),
                resumed: false,
              });
              // Ordinary production hires have no NativeLaunchPolicy. Repeat their
              // actual usage/project/tool/resource admission without a one-shot override.
              await recheckPlan(false, true);
              await ctx.admitProjectLaunch(input, false, restartAuthority);
              await checkExpectedTools();
              if (ctx.fleetResources) await ctx.fleetResources.admitHire(input);
              await restartFreshness();
              await restartRevocation();
            };
            const restartView: SeatView = {
              paneId,
              name: subject,
              ...(expectedToolNames === undefined ? {} : { expectedToolNames }),
              guard: restartRevocation,
              question: (ref, question) => ctx.forwardNativeQuestion(ref, question),
              run: async (argv) => {
                await restartRevocation();
                if (nativePrepared || !runInPane)
                  throw new Error("Prepared native restart has no terminal fallback");
                await runInPane(paneId, argv);
              },
              start: async (harness, args) => {
                await restartRevocation();
                if (nativePrepared) throw new Error("Prepared native restart cannot launch another process");
                await startAgent({ name: subject, kind: harness, paneId, ...(args.length ? { args } : {}) });
              },
            };
            ctx.hiredRestarts.register({
              agent,
              originalBrief: effectiveLaunch.brief,
              workItem: input.deliverable,
              owner: authority.owner,
              adapter,
              launch: structuredClone(effectiveLaunch),
              view: launchView,
              restartView,
              admitRestart,
              control: started.control,
              proof,
              prepared: nativePrepared !== undefined,
              successor: async (previous, next, nextProof, restartReceiptId) => {
                const receipt = ctx.hiredRestarts.journal().find((entry) => entry.id === restartReceiptId);
                if (
                  !receipt ||
                  receipt.stage !== "launching" ||
                  receipt.paneId !== paneId ||
                  receipt.previousSessionId !== nativeSessionId(previous) ||
                  !receipt.previousProof ||
                  !previous.session ||
                  !next.session
                )
                  throw new Error("Original restart receipt does not authorize this successor");
                const previousOccupantId = occupantIdForHerdrSession(previous.session);
                const occupantId = occupantIdForHerdrSession(next.session);
                const sessionKey = ctx.nativeSessionKey(next);
                const previousSessionKey = ctx.nativeSessionKey(previous);
                if (!sessionKey || !previousSessionKey)
                  throw new Error("Successor native session key unavailable");
                const allocation = ctx.projectAllocations.get(input);
                if (allocation)
                  ctx.projectHires.restartSuccessor(
                    allocation,
                    restartReceiptId,
                    {
                      pane: paneId,
                      seat: previous.terminalId,
                      occupantId: previousOccupantId,
                      proof: receipt.previousProof as ProjectHireProcessProof,
                    },
                    { seat: next.terminalId, occupantId, proof: nextProof },
                  );
                ctx.hireOwners.restartSuccessor({
                  receiptId: restartReceiptId,
                  paneId,
                  previousSeatId: previous.terminalId,
                  previousOccupantId,
                  previousSessionKey,
                  seatId: next.terminalId,
                  occupantId,
                  sessionKey,
                  owner: authority.owner,
                });
                ctx.retireReboundWatches(
                  [{ seatId: previous.terminalId, occupantId: previousOccupantId }],
                  next,
                );
                ctx.watchHiredSeat(next.terminalId, occupantId, authority.owner);
                restartAgent = next;
              },
            });
          }
          return {
            ...spawnedSeat(agent, paneId, subject, input, account),
            control,
            ...(effectiveLaunch.harness === "claude"
              ? { permissionMode: claudeWorkerPermissionMode(effectiveLaunch) }
              : {}),
          };
        }
        // A prepared initial command may already be alive; never treat its pane
        // as an empty shell or close it on an unproved controller result.
        await nativePrepared?.dispose();
        if (!nativePrepared) await ctx.runner.closePane?.(paneId).catch(() => undefined);
        return {
          outcome: "failed",
          reason: "not_ready",
          detail: started.detail,
          control: { mode: "unavailable", reason: started.reason, detail: started.detail, fix: started.fix },
        };
      }
      const args = [
        ...skillLaunch.args,
        // Bare Codex hires use its shared daemon: the terminal cwd does not select the thread cwd.
        ...(input.harness === "codex" ? ["--cd", ctx.nativeCheckout(input.workingDirectory)] : []),
        ...(input.harness === "codex" && remote === undefined ? fleetSeatCodexStartArgs() : []),
        ...modelArgs,
        ...effortArgs,
        ...chromeArgs,
        ...(resume === undefined ? [] : nativeResumeArgs(resume)),
      ];
      await ctx.admitProjectLaunch(input);
      if (ctx.fleetResources) await ctx.admitResourceMutation(input, authority);
      startAttempted = true;
      await startAgent({
        name: subject,
        kind: input.harness,
        paneId,
        ...(args.length === 0 ? {} : { args }),
      });
      if (resume !== undefined) {
        const agent = await ctx.agentWithSession(paneId, SPAWN_SESSION_WAIT_MS);
        if (nativeSessionId(agent) !== resume.sessionId)
          throw new Error("The native seat has not confirmed the saved session identity; no brief was sent");
      }
      const agent = await ctx.agentWithSession(
        paneId,
        fleetSeatBriefStartsSession(input.harness) ? SPAWN_FIRST_TURN_SESSION_WAIT_MS : SPAWN_SESSION_WAIT_MS,
      );
      if (agent.session === undefined) {
        throw new Error(
          fleetSeatBriefStartsSession(input.harness) && brief === undefined
            ? `${input.harness} reports its session on its first turn; hire it with a brief`
            : "Herdr started an agent without a durable session identity",
        );
      }
      await ctx.observeHireIdentity(receiptKey, agent, input, authority);
      await labelConfirmedResume(agent);
      return {
        ...spawnedSeat(agent, paneId, subject, input, account),
        control,
      };
    } catch (caught) {
      await nativePrepared?.dispose();
      const failure = await ctx.startupFailure(paneId, input.harness, reasonDetail(caught));
      if (nativePrepared || (startAttempted && failure.reason !== "harness_unavailable"))
        return {
          ...failure,
          reason: failure.reason === "trust_required" ? "trust_required" : "start_unconfirmed",
          detail: `${failure.detail ?? reasonDetail(caught)}; inspect pane ${paneId} before retrying`,
          ...(control === undefined ? {} : { control }),
        };
      await ctx.runner.closePane?.(paneId).catch(() => undefined);
      return { ...failure, ...(control === undefined ? {} : { control }) };
    }
  }

  /** Inspect before closing the failed pane; trust and channel consent belong to the owner. */
  async function startupFailure(
    paneId: string,
    harness: string,
    detail: string,
    reason: HerdrSeatSpawnFailure["reason"] = spawnFailureReason(detail),
  ): Promise<HerdrSeatSpawnFailure> {
    const visible = await ctx.runner.read?.(paneId, harness, "visible").catch(() => undefined);
    let failure: HerdrSeatSpawnFailure = { outcome: "failed", reason, detail };
    if (
      // Claude Code 2.1.281 asks "Quick safety check … Yes, I trust this folder".
      (harness === "claude" &&
        (visible?.includes("Do you trust the files in this folder?") ||
          visible?.includes("Yes, I trust this folder"))) ||
      (harness === "codex" &&
        (visible?.includes("Trust this folder?") || visible?.includes("Hooks need review")))
    )
      failure = {
        outcome: "failed",
        reason: "trust_required",
        detail: `${harness} is waiting for hook or folder trust. Review the trust prompt in pane ${paneId}; no trust was accepted. ${detail}`,
      };
    else if (
      harness === "claude" &&
      visible !== undefined &&
      /Bypass\s+Permissions\s+mode/u.test(stripVTControlCharacters(visible)) &&
      /Yes,\s+I\s+accept/u.test(stripVTControlCharacters(visible))
    )
      failure = {
        outcome: "failed",
        reason: "trust_required",
        detail: `bypass_confirmation_required: Claude is waiting for its one-time bypass confirmation. Fix: only the owner may review and accept it in pane ${paneId}, using the same Claude profile (account / CLAUDE_CONFIG_DIR). Inspect this original hire before retrying; no confirmation was accepted. ${detail}`,
      };
    else if (harness === "claude" && visible?.includes(CHANNEL_DIALOG_MARKER))
      failure = { outcome: "failed", reason: "not_ready", detail: CLAUDE_CHANNEL_CONSENT_REQUIRED };
    const agent = await ctx.runner.get(paneId).catch(() => undefined);
    const session = agent?.session;
    console.warn(
      "hire_agent.startup_failed:",
      JSON.stringify({
        harness,
        paneId,
        sessionId:
          session === undefined
            ? null
            : session.kind === "id"
              ? session.value
              : basename(session.value, ".jsonl"),
        transcriptPath:
          session === undefined || splitFleetQualified(paneId) !== undefined
            ? null
            : (resolveHerdrSeatTranscriptPath(harness, session) ?? null),
        rejectingRule: failure.reason,
        detail: redactSensitiveText(failure.detail ?? ""),
      }),
    );
    return failure;
  }

  /**
   * Herdr calls a harness started once it takes input, which can be before the
   * harness has written the session file Herdr reports as its identity — pi
   * writes one on launch, so the gap is a race, not an absence. Waiting through
   * it is what keeps a good hire from being torn down as a failure.
   */
  /** A host checkout's path as this runner's panes and native threads see it (#402). */
  function nativeCheckout(workingDirectory: string): string {
    return ctx.runner.nativeWorkingDirectory?.(workingDirectory) ?? workingDirectory;
  }

  async function agentWithSession(paneId: string, waitMs: number): Promise<HerdrAgentSnapshot> {
    const deadline = Date.now() + waitMs;
    let agent = await ctx.runner.get(paneId);
    while (agent.session === undefined && Date.now() < deadline) {
      await delay(SPAWN_SESSION_POLL_MS);
      agent = await ctx.runner.get(paneId);
    }
    return agent;
  }
  return {
    resumeSeat,
    observeHireIdentity,
    startSeat,
    launchSeat,
    startupFailure,
    nativeCheckout,
    agentWithSession,
  };
}
