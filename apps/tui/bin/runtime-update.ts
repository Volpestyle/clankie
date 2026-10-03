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
}
export interface RuntimeBootIdentity {
  readonly root: string;
  readonly commit: string;
  readonly instanceId: string;
  readonly pid: number;
}
interface RuntimeServiceReceipt {
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
  readonly serviceReceipts?: readonly RuntimeServiceReceipt[];
}
export interface RuntimeUpdatePorts {
  readonly run: InstallCommand;
  /** Existing CLI service supervisor; a successful stop means all exact owned services stopped. */
  readonly services: (runtime: string, action: "down" | "restart") => Promise<RuntimeServiceReceipt>;
  readonly now?: () => Date;
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
  for (const key of Object.keys(value))
    if (
      ![
        "id",
        "ref",
        "oldCommit",
        "newCommit",
        "phase",
        "updatedAt",
        "healthy",
        "rollbackHealthy",
        "reason",
        "serviceReceipts",
      ].includes(key)
    )
      throw Error("Unknown update result field");
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
    ...(value.healthy === undefined ? {} : { healthy: value.healthy as boolean }),
    ...(value.rollbackHealthy === undefined ? {} : { rollbackHealthy: value.rollbackHealthy as boolean }),
    ...(value.reason === undefined ? {} : { reason: boundedString(value.reason, 256) }),
    ...(value.serviceReceipts === undefined
      ? {}
      : { serviceReceipts: (value.serviceReceipts as unknown[]).map(parseServiceReceipt) }),
  };
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
    return persist("healthy", { healthy: true });
  } catch {
    if (!oldStopped)
      return persist(stopAttempted ? "stop-unconfirmed" : "failed", {
        reason: stopAttempted ? "old-services-stop-unconfirmed" : "pre-cutover-failed",
      });
    try {
      if (newMoved) {
        if (!(await service("down", plan.newCommit)))
          return persist("stop-unconfirmed", { reason: "new-services-stop-unconfirmed", healthy: false });
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
        healthy: false,
        rollbackHealthy,
      });
    } catch {
      return persist("failed", { reason: "rollback-unconfirmed", healthy: false, rollbackHealthy: false });
    }
  }
}
