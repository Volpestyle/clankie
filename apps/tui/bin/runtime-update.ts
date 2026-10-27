/**
 * Detached update transaction. Only the helper executes this engine; imports do not install or restart.
 * The helper runs a private copy of this file beside `pinned-runtime.ts` and `update-files.ts`, outside
 * any workspace, so it may import only `node:` builtins and those copies.
 */
import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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
  readonly ownerCheckoutSync?: CheckoutSyncResult;
  readonly resolvedRef?: string;
  readonly warning?: RuntimeUpdateResult["warning"];
  readonly initiator?: RuntimeUpdateInitiator;
}
/** `@clankie/settings` CheckoutSyncResult, restated here because the copied helper cannot import packages. */
export interface CheckoutSyncResult {
  readonly path: string;
  readonly outcome: "current" | "updated" | "blocked" | "unavailable";
  readonly before?: string | undefined;
  readonly after?: string | undefined;
  readonly reason?: string | undefined;
  readonly blockers: readonly { readonly path: string; readonly ageSeconds?: number | undefined }[];
}
/** Mirrors `CheckoutSyncResultSchema` in `@clankie/protocol` (strict keys, same fields). */
export function parseCheckoutSyncResult(input: unknown): CheckoutSyncResult {
  const value = object(input);
  const text = (key: string) => {
    if (typeof value[key] !== "string") throw Error("Invalid owner checkout sync");
    return value[key] as string;
  };
  if (
    Object.keys(value).some(
      (key) => !["path", "outcome", "before", "after", "reason", "blockers"].includes(key),
    ) ||
    !["current", "updated", "blocked", "unavailable"].includes(String(value.outcome)) ||
    !Array.isArray(value.blockers)
  )
    throw Error("Invalid owner checkout sync");
  return {
    path: text("path"),
    outcome: value.outcome as CheckoutSyncResult["outcome"],
    ...Object.fromEntries(
      (["before", "after", "reason"] as const)
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, text(key)]),
    ),
    blockers: (value.blockers as unknown[]).map((entry) => {
      const blocker = object(entry);
      const ageSeconds = blocker.ageSeconds;
      if (
        Object.keys(blocker).some((key) => key !== "path" && key !== "ageSeconds") ||
        typeof blocker.path !== "string" ||
        (ageSeconds !== undefined && (typeof ageSeconds !== "number" || !(ageSeconds >= 0)))
      )
        throw Error("Invalid owner checkout blocker");
      return {
        path: blocker.path,
        ...(ageSeconds === undefined ? {} : { ageSeconds: ageSeconds as number }),
      };
    }),
  };
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
  /** Read-time sidecar projection; never written to the cutover journal. */
  readonly pressure?: {
    readonly state: "busy" | "clear" | "unavailable";
    readonly load1?: number;
    readonly load15?: number;
    readonly cores?: number;
    readonly externalLoadRatio?: number;
    readonly externalCpuRatio?: number;
    readonly cpuPercent?: number;
    readonly healthLatencyMs?: number;
    readonly observedAt: string;
  };
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
  readonly harnessRefresh?: {
    readonly ok: boolean;
    readonly result?: unknown;
    readonly error?: string;
    readonly sourceManaged?: readonly { home: string; machine: string; fix: string }[];
  };
  readonly canary?: RuntimeCanaryResult;
  readonly ownerCheckoutSync?: CheckoutSyncResult;
  readonly resolvedRef?: string;
  readonly warning?: "older-than-current-pin" | "diverged-from-current-pin";
  readonly initiator?: RuntimeUpdateInitiator;
  /** An uncertain ending the running service later proved safe; it retires the lock. */
  readonly reconciled?: RuntimeUpdateReconciliation;
  /** Release installs: the official versions behind `oldCommit` and `newCommit`. */
  readonly versions?: { readonly old: string; readonly new: string };
  /** Services left running across the cutover because none of their code changed. */
  readonly keptServices?: readonly string[];
}
interface RuntimeUpdateReconciliation {
  readonly at: string;
  /** The pinned commit the reconciling service booted from. */
  readonly commit: string;
  readonly instanceId: string;
}
/**
 * Services a cutover may leave running when none of their code changed. The
 * Discord bodies are absent: their live presence claim is only valid against
 * the service instance that issued it, so they restart with every clankie
 * restart. `awake` is a `caffeinate`, which no update changes.
 */
const KEEPABLE_SERVICES: Readonly<Record<string, string | undefined>> = {
  relay: "apps/relay/src/index.ts",
  activity: "apps/discord-activity/src/index.ts",
  awake: undefined,
};
/** Whether the target runtime's `clankie restart` accepts `--keep`; an older one would refuse it. */
function restartKeeps(stage: string): boolean {
  try {
    return readFileSync(join(stage, "apps/tui/src/command/restart.ts"), "utf8").includes(`"--keep"`);
  } catch {
    return false;
  }
}

/**
 * Which keepable services may stay up across `oldCommit..newCommit`: those whose
 * entrypoint can load no file the range changed (VUH-2393). Every update used
 * to restart the relay and keep-awake with the service; 303 Discord bridge and
 * relay restarts in two weeks of October came from self-updates. Any doubt — an
 * import it cannot follow, a dependency manifest or lockfile change, a failed
 * diff — restarts the service, as before.
 */
function unchangedServices(
  stage: string,
  oldCommit: string,
  newCommit: string,
  run: InstallCommand,
  repository: string,
): readonly string[] {
  if (!restartKeeps(stage)) return [];
  let changed: readonly string[];
  try {
    changed = run("git", ["diff", "--name-only", "--no-renames", oldCommit, newCommit, "--"], repository)
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
  const packages = workspacePackages(stage);
  return Object.entries(KEEPABLE_SERVICES).flatMap(([id, entry]) => {
    if (entry === undefined) return [id];
    const sources = serviceSources(stage, entry, packages);
    return sources !== undefined && !changed.some((path) => sources(path)) ? [id] : [];
  });
}

const ROOT_INPUTS = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  ".node-version",
]);
const CODE = /\.(?:[cm]?[jt]s|tsx)$/u;

interface WorkspacePackage {
  readonly name: string;
  readonly directory: string;
  readonly exports: unknown;
}

function workspacePackages(root: string): readonly WorkspacePackage[] {
  const found: WorkspacePackage[] = [];
  for (const group of ["apps", "integrations", "packages"]) {
    let entries: string[];
    try {
      entries = readdirSync(join(root, group));
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const manifest = JSON.parse(readFileSync(join(root, group, entry, "package.json"), "utf8")) as {
          name?: unknown;
          exports?: unknown;
          main?: unknown;
        };
        if (typeof manifest.name === "string")
          found.push({
            name: manifest.name,
            directory: `${group}/${entry}`,
            exports: manifest.exports ?? manifest.main ?? "./src/index.ts",
          });
      } catch {
        // Not a package.
      }
    }
  }
  return found;
}

/** The export target for `./sub` (or `.`), following the `import`/`default` condition. */
function exportTarget(exports: unknown, subpath: string): string | undefined {
  const pick = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (value !== null && typeof value === "object") {
      const conditions = value as Record<string, unknown>;
      return pick(conditions.import ?? conditions.node ?? conditions.default);
    }
    return undefined;
  };
  if (typeof exports === "string") return subpath === "." ? exports : undefined;
  if (exports === null || typeof exports !== "object") return undefined;
  const map = exports as Record<string, unknown>;
  if (!Object.keys(map).some((key) => key.startsWith("."))) return subpath === "." ? pick(map) : undefined;
  if (map[subpath] !== undefined) return pick(map[subpath]);
  for (const [key, value] of Object.entries(map)) {
    const star = key.indexOf("*");
    if (star === -1 || !subpath.startsWith(key.slice(0, star)) || !subpath.endsWith(key.slice(star + 1)))
      continue;
    const match = subpath.slice(star, subpath.length - (key.length - star - 1));
    return pick(value)?.replaceAll("*", match);
  }
  return undefined;
}

function sourceFile(path: string): string | undefined {
  const candidates = /\.[cm]?js$/u.test(path)
    ? [path, path.replace(/js$/u, "ts")]
    : CODE.test(path) || path.endsWith(".json")
      ? [path]
      : [`${path}.ts`, `${path}.js`, join(path, "index.ts"), join(path, "index.js")];
  return candidates.find((candidate) => {
    try {
      return lstatSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Follows a service's static and literal dynamic imports through the workspace
 * and returns a predicate over repository paths that could change what it
 * runs: every file it can load, the assets and manifests of the packages those
 * live in, and the root dependency inputs. External packages are covered by the
 * lockfile. Undefined when an import cannot be followed.
 */
function serviceSources(
  root: string,
  entry: string,
  packages: readonly WorkspacePackage[],
): ((path: string) => boolean) | undefined {
  const files = new Set<string>();
  const opaque = new Set<string>();
  const queue = [join(root, entry)];
  const owner = (path: string) =>
    packages.find((candidate) => path === candidate.directory || path.startsWith(`${candidate.directory}/`));
  const specifiers =
    /(?:\bimport|\bexport)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"'\n]+)["']|\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)|\brequire(?:\.resolve)?\s*\(\s*["']([^"'\n]+)["']\s*\)|new\s+URL\(\s*["']([^"'\n]+)["']\s*,\s*import\.meta\.url/gu;
  while (queue.length > 0) {
    const file = queue.pop()!;
    const path = relative(root, file).split(sep).join("/");
    if (path.startsWith("..") || files.has(path)) continue;
    if (files.size >= 5_000) return undefined;
    files.add(path);
    if (!CODE.test(file)) continue;
    const text = readFileSync(file, "utf8");
    // A computed specifier can load any module of its package.
    if (/\bimport\s*\(\s*(?!["'\s])/u.test(text)) {
      const pkg = owner(path);
      if (pkg === undefined) return undefined;
      opaque.add(pkg.directory);
    }
    for (const match of text.matchAll(specifiers)) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? match[4]!;
      // Builtins, and absolute paths, which only appear inside strings such as a sandbox profile.
      if (specifier.startsWith("node:") || specifier.startsWith("/")) continue;
      if (specifier.startsWith(".")) {
        const target = sourceFile(resolve(dirname(file), specifier));
        if (target === undefined) {
          // A missing asset or an optional sibling is a change only if the range touches it.
          if (match[4] !== undefined || match[3] !== undefined) continue;
          return undefined;
        }
        queue.push(target);
        continue;
      }
      const pkg = packages
        .filter((candidate) => specifier === candidate.name || specifier.startsWith(`${candidate.name}/`))
        .sort((a, b) => b.name.length - a.name.length)[0];
      if (pkg === undefined) continue;
      const subpath = specifier === pkg.name ? "." : `.${specifier.slice(pkg.name.length)}`;
      const exported = exportTarget(pkg.exports, subpath);
      const target = exported === undefined ? undefined : sourceFile(join(root, pkg.directory, exported));
      if (target === undefined) return undefined;
      queue.push(target);
    }
  }
  const directories = new Set([...files].flatMap((path) => owner(path)?.directory ?? []));
  return (path) => {
    if (files.has(path) || ROOT_INPUTS.has(path) || path.startsWith("patches/")) return true;
    const pkg = owner(path);
    if (pkg === undefined || !directories.has(pkg.directory)) return false;
    const inside = path.slice(pkg.directory.length + 1);
    if (inside === "package.json") return true;
    if (/(?:^|\/)test\//u.test(inside) || /\.test\.[cm]?[jt]s$/u.test(inside) || inside.endsWith(".md"))
      return false;
    return !CODE.test(inside) || opaque.has(pkg.directory);
  };
}

/** Pin cutover leaves the external activity tunnel running under its current owner. */
export async function runtimeUpdateServices(
  runtime: string,
  action: "down" | "restart",
  cli: (runtime: string, args: readonly string[]) => Promise<unknown>,
  env: NodeJS.ProcessEnv = process.env,
  keep: readonly string[] = [],
): Promise<RuntimeServiceReceipt> {
  // This helper is copied without workspace dependencies. Respect the same
  // image loadout the existing supervisor receives, including disabled activity.
  const loadout = env.CLANKIE_SERVICES?.trim();
  const activity =
    (!loadout || loadout.split(",").some((id) => id.trim() === "activity")) && !keep.includes("activity");
  // A kept service keeps running from the previous runtime's files, which retention retains while it does.
  const kept = keep.filter((id) => id !== "activity");
  const targets =
    action === "down"
      ? [
          ...(keep.includes("activity") ? [] : ["activity"]),
          "discord-user-session",
          "discord-bridge",
          ...(keep.includes("relay") ? [] : ["relay"]),
          "clankie",
        ]
      : ["clankie", ...(activity ? ["activity"] : [])];
  const services: RuntimeServiceReceipt["services"][number][] = [];
  let ok = true;
  for (const target of targets) {
    let outcome: unknown;
    try {
      outcome = await cli(runtime, [
        action,
        target,
        ...(action === "restart" && target === "clankie" && kept.length > 0
          ? ["--keep", kept.join(",")]
          : []),
      ]);
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
  /**
   * Existing CLI service supervisor; a successful stop means all exact owned
   * pin-dependent services stopped, except the `keep` set, which neither stops
   * nor restarts.
   */
  readonly services: (
    runtime: string,
    action: "down" | "restart",
    keep: readonly string[],
  ) => Promise<RuntimeServiceReceipt>;
  readonly now?: () => Date;
  readonly refreshHarnesses?: (runtime: string) => Promise<{ ok: boolean }>;
  /** Fresh complete native census + live launcher/bridge bindings; never a cached doctor report. */
  readonly operatorSeatsReady?: (runtime: string) => Promise<boolean>;
  /** Waits before retrying an unconfirmed stop or restart; defaults to 10 s, then 30 s. */
  readonly retryDelaysMs?: readonly number[];
}

/**
 * A loaded Mac can leave a stop or restart unconfirmed for seconds (VUH-2293).
 * Retry before treating the cutover as failed or leaving services down.
 */
const SERVICE_RETRY_DELAYS_MS = [10_000, 30_000];

/** Release policy, carried by the target artifact. Unknown enforcing targets fail closed. */
export function targetRequiresSeatBindings(runtime: string): boolean {
  const path = join(runtime, "apps/clankie/operator-seat-policy.json");
  if (!existsSync(path)) return existsSync(join(runtime, "apps/clankie/src/operator-seat-bindings.ts"));
  const policy = object(JSON.parse(readFileSync(path, "utf8")));
  if (
    policy.schemaVersion !== 1 ||
    !["observe", "enforce"].includes(String(policy.mode)) ||
    Object.keys(policy).some((key) => !["schemaVersion", "mode"].includes(key))
  )
    throw Error("Target operator seat policy is invalid");
  return policy.mode === "enforce";
}

export async function operatorSeatsReady(read: (() => Promise<boolean>) | undefined): Promise<boolean> {
  try {
    return (await read?.()) === true;
  } catch {
    return false;
  }
}

export async function waitForOperatorSeatRecovery(read: (() => Promise<boolean>) | undefined): Promise<void> {
  const until = Date.now() + 30_000;
  while (!(await operatorSeatsReady(read))) {
    if (Date.now() >= until)
      throw Error("Operator seat bindings did not recover; enforcement cutover is not healthy");
    await sleep(500);
  }
}

export function readRuntimeUpdate(directory: string): RuntimeUpdateResult {
  const value = object(readPrivateJson(join(directory, "result.json")));
  if (value.harnessRefresh !== undefined) {
    const refresh = object(value.harnessRefresh);
    value.harnessRefresh = withHarnessRefreshDiagnostics(refresh, directory);
    if (value.reason === "harness-refresh-incomplete" && object(value.harnessRefresh).sourceManaged)
      value.reason = "harness-refresh-source-managed";
  }
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
    ...(value.ownerCheckoutSync === undefined
      ? {}
      : { ownerCheckoutSync: parseCheckoutSyncResult(value.ownerCheckoutSync) }),
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
    ...(value.keptServices === undefined
      ? {}
      : {
          keptServices: (Array.isArray(value.keptServices) ? value.keptServices : [])
            .slice(0, 8)
            .map((id) => boundedString(id, 64)),
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

/** Explicit rollback targets respect release installs' version-only update contract. */
export function runtimeRollbackRef(result: RuntimeUpdateResult): string {
  const commit = result.canary?.previousHealthyCommit ?? result.oldCommit;
  return result.versions && commit === result.oldCommit ? result.versions.old : commit;
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

export function parseHarnessRefresh(input: unknown): NonNullable<RuntimeUpdateResult["harnessRefresh"]> {
  const value = object(input);
  if (typeof value.ok !== "boolean") throw Error("Invalid harness refresh receipt");
  return {
    ok: value.ok,
    ...(value.result === undefined ? {} : { result: value.result }),
    ...(value.error === undefined ? {} : { error: boundedString(value.error, 1024) }),
    ...(value.sourceManaged === undefined
      ? {}
      : {
          sourceManaged: (value.sourceManaged as unknown[]).slice(0, 32).map((entry) => {
            const item = object(entry);
            return {
              home: boundedString(item.home, 4096),
              machine: boundedString(item.machine, 256),
              fix: boundedString(item.fix, 8192),
            };
          }),
        }),
  };
}

/** Read the retained receipt only at this operation's fixed path; never follow a response-supplied path. */
export function withHarnessRefreshDiagnostics(
  refresh: Record<string, unknown>,
  directory: string,
): Record<string, unknown> {
  let receipt = refresh.result;
  try {
    receipt = readPrivateJson(join(directory, "harness-refresh.json"));
  } catch {
    /* Older/direct ports retain inline results. */
  }
  if (!receipt || typeof receipt !== "object") return refresh;
  const data = receipt as Record<string, unknown>;
  const sourceManaged: { home: string; machine: string; fix: string }[] = [];
  const collect = (entries: unknown, machine: string) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const value = entry as Record<string, unknown>;
      // Old receipts called a missing source hook declined; retain that distinction only for this exact detail.
      if (
        value.status !== "source-manager-required" &&
        !(
          value.status === "declined" &&
          typeof value.detail === "string" &&
          value.detail.includes("configuration is managed at") &&
          value.detail.includes("Use its source setup")
        )
      )
        continue;
      if (typeof value.profile !== "string") continue;
      sourceManaged.push({
        home: value.profile,
        machine,
        fix:
          value.harness === "claude"
            ? "Apply the worker plugin setup through the source that owns this profile's settings. Preserve the configuration link."
            : "Have the configuration owner provide a source-owned script; run clankie harness install --codex-source-setup /absolute/source-owned/script --approve in this profile. Preserve the configuration link.",
      });
    }
  };
  collect(data.local, "local");
  if (Array.isArray(data.fleets))
    for (const entry of data.fleets) {
      if (!entry || typeof entry !== "object") continue;
      const fleet = entry as Record<string, unknown>;
      if (typeof fleet.fleet === "string" && fleet.result && typeof fleet.result === "object")
        collect((fleet.result as Record<string, unknown>).installations, fleet.fleet);
    }
  return sourceManaged.length ? { ...refresh, sourceManaged } : refresh;
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
  // Set once the new runtime is installed; a rollback restarts everything.
  let keep: readonly string[] = [];
  const attempt = async (action: "down" | "restart", expectedCommit: string, retry: boolean) => {
    const keeping = action === "restart" && expectedCommit !== plan.newCommit ? [] : keep;
    const receipt = parseServiceReceipt(await ports.services(plan.runtime, action, keeping));
    // The record keeps one receipt per step, its latest; every attempt stays in the log.
    if (retry) serviceReceipts.pop();
    serviceReceipts.push(receipt);
    appendFileSync(
      join(plan.directory, "service-attempts.jsonl"),
      `${JSON.stringify({ at: (ports.now?.() ?? new Date()).toISOString(), action, receipt })}\n`,
      { mode: 0o600 },
    );
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
  const service = async (action: "down" | "restart", expectedCommit: string) => {
    const delays = ports.retryDelaysMs ?? SERVICE_RETRY_DELAYS_MS;
    let attempted = false;
    for (let index = 0; ; index += 1) {
      try {
        const settled = await attempt(action, expectedCommit, attempted);
        attempted = true;
        if (settled) return true;
      } catch (error) {
        if (index >= delays.length) throw error;
      }
      if (index >= delays.length) return false;
      await sleep(delays[index]!);
    }
  };
  const persist = (phase: RuntimeUpdateResult["phase"], fields: Partial<RuntimeUpdateResult> = {}) => {
    const result: RuntimeUpdateResult = {
      id: plan.id,
      ref: plan.ref,
      oldCommit: plan.oldCommit,
      newCommit: plan.newCommit,
      ...(plan.ownerCheckoutSync === undefined ? {} : { ownerCheckoutSync: plan.ownerCheckoutSync }),
      ...(plan.resolvedRef === undefined ? {} : { resolvedRef: plan.resolvedRef }),
      ...(plan.warning === undefined ? {} : { warning: plan.warning }),
      ...(plan.initiator === undefined ? {} : { initiator: plan.initiator }),
      phase,
      updatedAt: (ports.now?.() ?? new Date()).toISOString(),
      ...(serviceReceipts.length === 0 ? {} : { serviceReceipts: [...serviceReceipts] }),
      ...(keep.length === 0 ? {} : { keptServices: keep }),
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
    // Build source-only projected artifacts before stopping the old service.
    if (existsSync(join(stage, "scripts/build-remote-lead.mjs")))
      run(process.execPath, ["scripts/build-remote-lead.mjs"], stage);
    // The checkout's native fleet proof helper, so the first start after cutover compiles nothing.
    if (existsSync(join(stage, "scripts/build-fleet-proof.mjs")))
      run(process.execPath, ["scripts/build-fleet-proof.mjs"], stage);
    linkPinnedState(plan.checkout, stage, run);
    relocatePinnedDependencies(stage, plan.runtime, undefined, plan.checkout);
    // Installation may take minutes; do not stop a runtime edited or replaced meanwhile.
    if (
      assertPinnedRuntime(plan.checkout, plan.runtime, run) !== plan.oldCommit ||
      assertPinnedRuntime(plan.checkout, stage, run) !== plan.newCommit
    )
      return persist("refused", { reason: "runtime-changed-during-install" });
    if (existsSync(backup)) throw Error("Previous runtime destination already exists");
    keep = unchangedServices(stage, plan.oldCommit, plan.newCommit, run, plan.checkout);
    // The preparation release's helper performs this before stopping any
    // service. An old/missing/incomplete census is never readiness evidence.
    const enforceSeats = targetRequiresSeatBindings(stage);
    const readSeats = ports.operatorSeatsReady ? () => ports.operatorSeatsReady!(plan.runtime) : undefined;
    if (enforceSeats && !(await operatorSeatsReady(readSeats)))
      return persist("refused", { reason: "operator-seats-unready" });
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
    if (enforceSeats) await waitForOperatorSeatRecovery(readSeats);
    // Plugin failures do not undo a healthy service cutover or restart any harness.
    let harnessRefresh: RuntimeUpdateResult["harnessRefresh"];
    if (ports.refreshHarnesses) {
      try {
        const result = await ports.refreshHarnesses(plan.runtime);
        harnessRefresh = parseHarnessRefresh(
          withHarnessRefreshDiagnostics({ ok: result.ok === true, result }, plan.directory),
        );
      } catch (error) {
        harnessRefresh = { ok: false, error: errorText(error) };
      }
    }
    return persist("healthy", {
      healthy: true,
      canary: { state: "pending" },
      ...(harnessRefresh
        ? {
            harnessRefresh,
            ...(harnessRefresh.ok
              ? {}
              : {
                  reason: harnessRefresh.sourceManaged?.length
                    ? "harness-refresh-source-managed"
                    : "harness-refresh-incomplete",
                }),
          }
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
