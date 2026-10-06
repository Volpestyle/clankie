/** Detached update transaction. Only the helper executes this engine; imports do not install or restart. */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  readPrivateJson,
  writePrivateJson,
  object,
  boundedString,
  commitString,
  operationId,
} from "./update-files.ts";
import {
  assertPinnedRuntime,
  createPinnedWorktree,
  installPinnedDependencies,
  installPinnedLinks,
  linkPinnedState,
  pinnedCommit,
  relocatePinnedDependencies,
  type InstallCommand,
} from "./pinned-runtime.ts";

export interface RuntimeUpdatePlan {
  readonly id: string;
  readonly ref: string;
  readonly checkout: string;
  readonly runtime: string;
  readonly home: string;
  readonly directory: string;
  readonly oldCommit: string;
  readonly newCommit: string;
  readonly oldInstanceId: string;
  readonly resolvedRef?: string;
  readonly warning?: RuntimeUpdateResult["warning"];
  readonly initiator?: RuntimeUpdateInitiator;
}
export interface RuntimeUpdateInitiator {
  /** `schedule` is a hosted body's own idle install (ADR 0237). */
  readonly kind: "operator" | "cli" | "conversation" | "schedule";
  readonly operatorId?: string;
  readonly conversationId?: string;
  /** CLI environment claims are attribution, never admission proof. */
  readonly claimedConversationId?: string;
  readonly claimedSeatSessionId?: string;
}
export function parseUpdateInitiator(input: unknown): RuntimeUpdateInitiator {
  const value = object(input);
  if (!["operator", "cli", "conversation", "schedule"].includes(String(value.kind)))
    throw Error("Invalid update initiator");
  return {
    kind: value.kind as RuntimeUpdateInitiator["kind"],
    ...Object.fromEntries(
      ["operatorId", "conversationId", "claimedConversationId", "claimedSeatSessionId"]
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, boundedString(value[key], 256)]),
    ),
  };
}
export interface RuntimeBootIdentity {
  readonly root: string;
  readonly commit: string;
  readonly instanceId: string;
  readonly pid: number;
}
export interface RuntimeServiceReceipt {
  readonly ok: boolean;
  readonly services: readonly {
    readonly id: string;
    readonly ok: boolean;
    readonly state?: string;
    readonly pid?: number;
    readonly detail?: string;
    readonly error?: string;
  }[];
  readonly runtime?: RuntimeBootIdentity;
}
export function parseServiceReceipt(input: unknown): RuntimeServiceReceipt {
  const value = object(input);
  if (
    typeof value.ok !== "boolean" ||
    !Array.isArray(value.services) ||
    value.services.length < 1 ||
    value.services.length > 16
  )
    throw Error("Invalid service receipt");
  const services = value.services.map((entry) => {
    const service = object(entry);
    if (typeof service.ok !== "boolean") throw Error("Invalid service outcome");
    const pid = service.pid;
    if (pid !== undefined && (!Number.isSafeInteger(pid) || Number(pid) < 1))
      throw Error("Invalid service pid");
    return {
      id: boundedString(service.id, 64),
      ok: service.ok,
      ...(service.state === undefined ? {} : { state: boundedString(service.state, 128) }),
      ...(pid === undefined ? {} : { pid: pid as number }),
      ...(service.detail === undefined ? {} : { detail: boundedString(service.detail, 1024) }),
      ...(service.error === undefined ? {} : { error: boundedString(service.error, 1024) }),
    };
  });
  let runtime: RuntimeBootIdentity | undefined;
  if (value.runtime !== undefined) {
    const source = object(value.runtime);
    if (!Number.isSafeInteger(source.pid) || Number(source.pid) < 1) throw Error("Invalid runtime pid");
    runtime = {
      root: boundedString(source.root, 4096),
      commit: commitString(source.commit),
      instanceId: operationId(source.instanceId),
      pid: source.pid as number,
    };
  }
  return { ok: value.ok, services, ...(runtime === undefined ? {} : { runtime }) };
}
/** Durable metadata only; canary failure never changes the cutover health result. */
export interface RuntimeCanaryResult {
  readonly state: "pending" | "passed" | "failed";
  readonly holdId?: string;
  readonly holdEstablished?: boolean;
  readonly holdReleased?: boolean;
  readonly previousHealthyCommit?: string;
  readonly instanceId?: string;
  readonly pid?: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly samples?: number;
  readonly cpuMeanPercent?: number;
  readonly healthP95Ms?: number;
  readonly error?: string;
  readonly alertState?: "pending" | "claimed" | "submitted" | "unavailable";
  readonly policy?: {
    readonly windowMs: number;
    readonly sampleIntervalMs: number;
    readonly cpuPercent: number;
    readonly healthLatencyMs: number;
  };
}
export interface RuntimeUpdateResult {
  readonly id: string;
  readonly ref: string;
  readonly oldCommit: string;
  readonly newCommit: string;
  readonly phase:
    | "scheduled"
    | "installing"
    | "stopping"
    | "activating"
    | "restarting"
    | "healthy"
    | "refused"
    | "failed"
    | "rolled-back"
    | "stop-unconfirmed";
  readonly updatedAt: string;
  readonly healthy?: boolean;
  readonly rollbackHealthy?: boolean;
  readonly reason?: string;
  /** The exception behind a failed `reason`; rollback failures keep their own. */
  readonly error?: string;
  readonly rollbackError?: string;
  readonly serviceReceipts?: readonly RuntimeServiceReceipt[];
  readonly harnessRefresh?: { readonly ok: boolean; readonly result?: unknown; readonly error?: string };
  readonly canary?: RuntimeCanaryResult;
  readonly resolvedRef?: string;
  readonly warning?: "older-than-current-pin" | "diverged-from-current-pin";
  readonly initiator?: RuntimeUpdateInitiator;
  /** An uncertain ending the running service later proved safe; it retires the lock. */
  readonly reconciled?: RuntimeUpdateReconciliation;
  /** Release installs: the official versions behind `oldCommit` and `newCommit`. */
  readonly versions?: { readonly old: string; readonly new: string };
}
interface RuntimeUpdateReconciliation {
  readonly at: string;
  /** The pinned commit the reconciling service booted from. */
  readonly commit: string;
  readonly instanceId: string;
}
/** Pin cutover leaves the external activity tunnel running under its current owner. */
export async function runtimeUpdateServices(
  runtime: string,
  action: "down" | "restart",
  cli: (runtime: string, args: readonly string[]) => Promise<unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeServiceReceipt> {
  // This helper is copied without workspace dependencies. Respect the same
  // image loadout the existing supervisor receives, including disabled activity.
  const loadout = env.CLANKIE_SERVICES?.trim();
  const activity = !loadout || loadout.split(",").some((id) => id.trim() === "activity");
  const targets =
    action === "down"
      ? ["activity", "discord-user-session", "discord-bridge", "relay", "clankie"]
      : ["clankie", ...(activity ? ["activity"] : [])];
  const services: RuntimeServiceReceipt["services"][number][] = [];
  let ok = true;
  for (const target of targets) {
    let outcome: unknown;
    try {
      outcome = await cli(runtime, [action, target]);
    } catch (error) {
      const stdout = (error as { stdout?: unknown }).stdout;
      if (typeof stdout !== "string") throw Error("Service result unavailable");
      outcome = JSON.parse(stdout);
    }
    const receipt = parseServiceReceipt(outcome);
    services.push(...receipt.services);
    ok &&= receipt.ok;
    if (!ok) break;
  }
  const receipt = parseServiceReceipt({ ok, services });
  if (action === "down" || !receipt.ok) return receipt;
  const status = object(await cli(runtime, ["update", "status"]));
  return parseServiceReceipt({ ...receipt, runtime: status.runtime });
}
export interface RuntimeUpdatePorts {
  readonly run: InstallCommand;
  /** Existing CLI service supervisor; a successful stop means all exact owned pin-dependent services stopped. */
  readonly services: (runtime: string, action: "down" | "restart") => Promise<RuntimeServiceReceipt>;
  readonly now?: () => Date;
  readonly refreshHarnesses?: (runtime: string) => Promise<{ ok: boolean }>;
}

export function readRuntimeUpdate(directory: string): RuntimeUpdateResult {
  const value = object(readPrivateJson(join(directory, "result.json")));
  const phases = [
    "scheduled",
    "installing",
    "stopping",
    "activating",
    "restarting",
    "healthy",
    "refused",
    "failed",
    "rolled-back",
    "stop-unconfirmed",
  ];
  if (!phases.includes(String(value.phase)) || !Number.isFinite(Date.parse(String(value.updatedAt))))
    throw Error("Invalid update result phase/time");
  // Results are responses: newer writers may add evidence older readers do not know.
  // Known fields remain validated; unknown evidence cannot authorize another mutation.
  if (
    value.warning !== undefined &&
    !["older-than-current-pin", "diverged-from-current-pin"].includes(String(value.warning))
  )
    throw Error("Invalid update warning");
  for (const key of ["healthy", "rollbackHealthy"])
    if (value[key] !== undefined && typeof value[key] !== "boolean") throw Error("Invalid update health");
  if (
    value.serviceReceipts !== undefined &&
    (!Array.isArray(value.serviceReceipts) || value.serviceReceipts.length > 6)
  )
    throw Error("Invalid service receipts");
  return {
    id: operationId(value.id),
    ref: boundedString(value.ref, 256),
    oldCommit: commitString(value.oldCommit),
    newCommit: commitString(value.newCommit),
    phase: value.phase as RuntimeUpdateResult["phase"],
    updatedAt: boundedString(value.updatedAt, 64),
    ...(value.resolvedRef === undefined ? {} : { resolvedRef: boundedString(value.resolvedRef, 512) }),
    ...(value.warning === undefined
      ? {}
      : { warning: value.warning as NonNullable<RuntimeUpdateResult["warning"]> }),
    ...(value.initiator === undefined ? {} : { initiator: parseUpdateInitiator(value.initiator) }),
    ...(value.healthy === undefined ? {} : { healthy: value.healthy as boolean }),
    ...(value.rollbackHealthy === undefined ? {} : { rollbackHealthy: value.rollbackHealthy as boolean }),
    ...(value.reason === undefined ? {} : { reason: boundedString(value.reason, 256) }),
    ...(value.error === undefined ? {} : { error: boundedString(value.error, 1024) }),
    ...(value.rollbackError === undefined ? {} : { rollbackError: boundedString(value.rollbackError, 1024) }),
    ...(value.serviceReceipts === undefined
      ? {}
      : { serviceReceipts: (value.serviceReceipts as unknown[]).map(parseServiceReceipt) }),
    ...(value.harnessRefresh === undefined
      ? {}
      : { harnessRefresh: parseHarnessRefresh(value.harnessRefresh) }),
    ...(value.canary === undefined ? {} : { canary: parseRuntimeCanary(value.canary) }),
    ...(value.reconciled === undefined ? {} : { reconciled: parseReconciliation(value.reconciled) }),
    ...(value.versions === undefined
      ? {}
      : {
          versions: {
            old: boundedString(object(value.versions).old, 64),
            new: boundedString(object(value.versions).new, 64),
          },
        }),
  };
}

function parseReconciliation(input: unknown): RuntimeUpdateReconciliation {
  const value = object(input);
  if (!Number.isFinite(Date.parse(String(value.at)))) throw Error("Invalid update reconciliation time");
  return {
    at: boundedString(value.at, 64),
    commit: commitString(value.commit),
    instanceId: operationId(value.instanceId),
  };
}

function parseRuntimeCanary(input: unknown): RuntimeCanaryResult {
  const value = object(input);
  const allowed = [
    "state",
    "holdId",
    "holdEstablished",
    "holdReleased",
    "previousHealthyCommit",
    "instanceId",
    "pid",
    "startedAt",
    "completedAt",
    "samples",
    "cpuMeanPercent",
    "healthP95Ms",
    "error",
    "alertState",
    "policy",
  ];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    !["pending", "passed", "failed"].includes(String(value.state))
  )
    throw Error("Invalid runtime canary state");
  for (const key of ["holdEstablished", "holdReleased"])
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw Error("Invalid runtime canary hold");
  for (const key of ["pid", "samples", "cpuMeanPercent", "healthP95Ms"])
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "number" || !Number.isFinite(value[key]) || Number(value[key]) < 0)
    )
      throw Error("Invalid runtime canary metric");
  if (value.pid !== undefined && (!Number.isSafeInteger(value.pid) || Number(value.pid) < 1))
    throw Error("Invalid runtime canary pid");
  if (value.samples !== undefined && !Number.isSafeInteger(value.samples))
    throw Error("Invalid runtime canary count");
  for (const key of ["startedAt", "completedAt"])
    if (value[key] !== undefined && !Number.isFinite(Date.parse(String(value[key]))))
      throw Error("Invalid runtime canary time");
  if (value.holdId !== undefined) operationId(value.holdId);
  if (value.instanceId !== undefined) operationId(value.instanceId);
  if (value.previousHealthyCommit !== undefined) commitString(value.previousHealthyCommit);
  if (value.error !== undefined) boundedString(value.error, 1024);
  if (
    value.alertState !== undefined &&
    !["pending", "claimed", "submitted", "unavailable"].includes(String(value.alertState))
  )
    throw Error("Invalid runtime canary alert");
  if (value.policy !== undefined) {
    const policy = object(value.policy);
    if (
      Object.keys(policy).sort().join(",") !== "cpuPercent,healthLatencyMs,sampleIntervalMs,windowMs" ||
      Object.values(policy).some((item) => typeof item !== "number" || !Number.isFinite(item) || item <= 0)
    )
      throw Error("Invalid runtime canary policy");
  }
  return value as unknown as RuntimeCanaryResult;
}

function parseHarnessRefresh(input: unknown): NonNullable<RuntimeUpdateResult["harnessRefresh"]> {
  const value = object(input);
  if (typeof value.ok !== "boolean") throw Error("Invalid harness refresh receipt");
  return {
    ok: value.ok,
    ...(value.result === undefined ? {} : { result: value.result }),
    ...(value.error === undefined ? {} : { error: boundedString(value.error, 1024) }),
  };
}

export function errorText(error: unknown): string {
  return (
    (error instanceof Error ? error.message : String(error)).replaceAll("\0", "").slice(0, 1024) ||
    "Unknown update failure"
  );
}

export function writeRuntimeUpdate(directory: string, result: RuntimeUpdateResult): void {
  writePrivateJson(join(directory, "result.json"), result);
}

export async function executeRuntimeUpdate(
  plan: RuntimeUpdatePlan,
  ports: RuntimeUpdatePorts,
): Promise<RuntimeUpdateResult> {
  const { run } = ports;
  const stage = join(plan.directory, "staged");
  const backup = join(plan.directory, "previous");
  const serviceReceipts: RuntimeServiceReceipt[] = [];
  const service = async (action: "down" | "restart", expectedCommit: string) => {
    const receipt = parseServiceReceipt(await ports.services(plan.runtime, action));
    serviceReceipts.push(receipt);
    if (
      !receipt.ok ||
      !receipt.services.every((entry) => entry.ok) ||
      !receipt.services.some((entry) => entry.id === "clankie")
    )
      return false;
    if (action === "down") return true;
    return (
      receipt.runtime?.root === plan.runtime &&
      receipt.runtime.commit === expectedCommit &&
      receipt.runtime.instanceId !== plan.oldInstanceId
    );
  };
  const persist = (phase: RuntimeUpdateResult["phase"], fields: Partial<RuntimeUpdateResult> = {}) => {
    const result: RuntimeUpdateResult = {
      id: plan.id,
      ref: plan.ref,
      oldCommit: plan.oldCommit,
      newCommit: plan.newCommit,
      ...(plan.resolvedRef === undefined ? {} : { resolvedRef: plan.resolvedRef }),
      ...(plan.warning === undefined ? {} : { warning: plan.warning }),
      ...(plan.initiator === undefined ? {} : { initiator: plan.initiator }),
      phase,
      updatedAt: (ports.now?.() ?? new Date()).toISOString(),
      ...(serviceReceipts.length === 0 ? {} : { serviceReceipts: [...serviceReceipts] }),
      ...fields,
    };
    writeRuntimeUpdate(plan.directory, result);
    return result;
  };
  let oldStopped = false;
  let stopAttempted = false;
  let oldMoved = false;
  let newMoved = false;
  const move = (from: string, to: string) => run("git", ["worktree", "move", from, to], plan.checkout);
  try {
    for (const path of [plan.home, plan.directory]) {
      const stat = lstatSync(path);
      if (
        !stat.isDirectory() ||
        realpathSync(path) !== resolve(path) ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw Error("Update paths changed");
    }
    if ((lstatSync(plan.directory).mode & 0o077) !== 0) throw Error("Update directory is not private");
    if (assertPinnedRuntime(plan.checkout, plan.runtime, run) !== plan.oldCommit)
      return persist("refused", { reason: "pinned-runtime-changed" });
    if (pinnedCommit(plan.checkout, plan.newCommit, run) !== plan.newCommit)
      return persist("refused", { reason: "resolved-commit-changed" });
    persist("installing");
    createPinnedWorktree(plan.checkout, stage, plan.newCommit, run);
    // Older targets cannot attest the restarted process; refuse before any service cutover.
    if (!existsSync(join(stage, "apps/tui/src/command/update.ts")))
      return persist("refused", { reason: "target-update-status-unsupported" });
    if (!existsSync(join(stage, "apps/clankie/src/runtime-canary.ts")))
      return persist("refused", { reason: "target-runtime-canary-unsupported" });
    installPinnedDependencies(stage, run);
    linkPinnedState(plan.checkout, stage, run);
    relocatePinnedDependencies(stage, plan.runtime, undefined, plan.checkout);
    // Installation may take minutes; do not stop a runtime edited or replaced meanwhile.
    if (
      assertPinnedRuntime(plan.checkout, plan.runtime, run) !== plan.oldCommit ||
      assertPinnedRuntime(plan.checkout, stage, run) !== plan.newCommit
    )
      return persist("refused", { reason: "runtime-changed-during-install" });
    if (existsSync(backup)) throw Error("Previous runtime destination already exists");
    persist("stopping");
    stopAttempted = true;
    if (!(await service("down", plan.oldCommit)))
      return persist("stop-unconfirmed", { reason: "old-services-stop-unconfirmed" });
    oldStopped = true;
    // Revalidate after the awaited shutdown before moving either worktree.
    if (
      assertPinnedRuntime(plan.checkout, plan.runtime, run) !== plan.oldCommit ||
      assertPinnedRuntime(plan.checkout, stage, run) !== plan.newCommit
    )
      throw Error("Runtime changed during shutdown");
    persist("activating");
    move(plan.runtime, backup);
    oldMoved = true;
    move(stage, plan.runtime);
    newMoved = true;
    await installPinnedLinks(plan.runtime, plan.home);
    persist("restarting");
    if (!(await service("restart", plan.newCommit))) throw Error("New services failed health checks");
    // Plugin failures do not undo a healthy service cutover or restart any harness.
    let harnessRefresh: RuntimeUpdateResult["harnessRefresh"];
    if (ports.refreshHarnesses) {
      try {
        const result = await ports.refreshHarnesses(plan.runtime);
        harnessRefresh = { ok: result.ok === true, result };
      } catch (error) {
        harnessRefresh = { ok: false, error: errorText(error) };
      }
    }
    return persist("healthy", {
      healthy: true,
      canary: { state: "pending" },
      ...(harnessRefresh
        ? { harnessRefresh, ...(harnessRefresh.ok ? {} : { reason: "harness-refresh-incomplete" }) }
        : {}),
    });
  } catch (failure) {
    const error = errorText(failure);
    if (!oldStopped)
      return persist(stopAttempted ? "stop-unconfirmed" : "failed", {
        reason: stopAttempted ? "old-services-stop-unconfirmed" : "pre-cutover-failed",
        error,
      });
    try {
      if (newMoved) {
        if (!(await service("down", plan.newCommit)))
          return persist("stop-unconfirmed", {
            reason: "new-services-stop-unconfirmed",
            error,
            healthy: false,
          });
        if (assertPinnedRuntime(plan.checkout, plan.runtime, run) !== plan.newCommit)
          throw Error("New runtime changed before rollback");
        move(plan.runtime, stage);
      }
      if (oldMoved) {
        if (assertPinnedRuntime(plan.checkout, backup, run) !== plan.oldCommit)
          throw Error("Previous runtime changed before rollback");
        move(backup, plan.runtime);
      }
      if (assertPinnedRuntime(plan.checkout, plan.runtime, run) !== plan.oldCommit)
        throw Error("Previous runtime changed before restart");
      await installPinnedLinks(plan.runtime, plan.home);
      const rollbackHealthy = await service("restart", plan.oldCommit);
      return persist(rollbackHealthy ? "rolled-back" : "failed", {
        reason: "cutover-failed",
        error,
        healthy: false,
        rollbackHealthy,
      });
    } catch (rollbackFailure) {
      return persist("failed", {
        reason: "rollback-unconfirmed",
        error,
        rollbackError: errorText(rollbackFailure),
        healthy: false,
        rollbackHealthy: false,
      });
    }
  }
}
