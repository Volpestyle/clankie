import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, renameSync, writeFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isLocalCodexEndpoint, type LocalCodexRecord } from "../local-codex-records.ts";
import type { LocalCodexSeats } from "../local-codex-seats.ts";
import { nativeRequest } from "../herdr-native-request.ts";
import { nativeProcessReceipt, observeCodexServer, observeNativeProcesses } from "../local-fleet-process.ts";
import { CodexAppServerClient, openCodexSocket } from "./codex-app-server.ts";
import { isolatedCodexConfig } from "./codex-catalog-refresh.ts";
import { occupantIdForHerdrSession } from "./herdr-census.ts";
import { codexToolCatalogReport } from "../../../../integrations/claude-plugin/worker/bin/codex-tool-catalog.mjs";

const KEY = "mcp_servers.clankie.env.CLANKIE_CATALOG_REVISION";
const REQUIRED_TOOLS = ["message_clankie", "message_clankie_status", "clankie_tools", "clankie_call"];
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const nested = (value: unknown, names: readonly string[]): unknown =>
  names.reduce<unknown>((part, name) => object(part)[name], value);
const requireProof = (ok: unknown, reason: string): void => {
  if (!ok) throw new Error(reason);
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const revisionValid = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/u.test(value);

export interface LocalCodexCatalogResult {
  paneId: string;
  threadId?: string;
  revision: string;
  outcome: "catalog-refreshed" | "skipped-busy" | "failed";
  reason?: string;
  detail?: string;
  catalogs?: { threadId: string; tools: string[] }[];
}
export interface LocalCodexCatalogIdentity {
  readonly proof: unknown;
  readonly endpoint: string;
  readonly requestedThreadId?: string;
  /** Final local registration/socket fence; runs without an intervening await. */
  assertCurrent(): void;
}
interface ThreadScope {
  id: string;
  cwd: string;
  parentThreadId: string | null;
  busy: boolean;
}
interface ConfigProvenance {
  home: string;
  filePath: string;
  expectedVersion: string;
  signalPath?: string;
  value?: string;
}
interface Attempt {
  version: 1;
  originalProof: string;
  revision: string;
  envRevision: string;
  filePath: string;
  expectedVersion: string;
  writtenVersion?: string;
  threads: string[];
  writeDispatched: boolean;
  writeConfirmed: boolean;
  reloadDispatched: boolean;
  reloadConfirmed: boolean;
  /** Original-thread MCP catalog only; never proof of next-step model exposure. */
  verified: boolean;
  authorityKind: "service" | "operator";
}
export interface LocalCodexCatalogRefreshInput {
  paneId?: string;
  revision: string;
  signal?: AbortSignal;
  beforeDispatch?: () => Promise<void>;
  current?: () => boolean;
}

/** Strict launch provenance; also checked against captured managed native argv. */
export function verifyLocalCodexCatalogOverrides(argv: readonly string[]): ReadonlyMap<string, unknown> {
  const overrides = new Map<string, unknown>();
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    requireProof(
      !["-p", "--profile"].includes(argument) &&
        !argument.startsWith("--profile=") &&
        !/^-[cp].+/u.test(argument),
      "native_codex_profile_or_override_unproven",
    );
    const expression =
      argument === "-c" || argument === "--config"
        ? argv[++index]
        : argument.startsWith("--config=")
          ? argument.slice(9)
          : undefined;
    if (expression === undefined) continue;
    const separator = expression.indexOf("=");
    requireProof(separator > 0, "native_codex_override_unparseable");
    const key = expression.slice(0, separator).trim();
    requireProof(
      !overrides.has(key) &&
        key !== KEY &&
        !(
          key.startsWith("mcp_servers.clankie") &&
          ![
            "mcp_servers.clankie.enabled",
            "mcp_servers.clankie.command",
            "mcp_servers.clankie.args",
            "mcp_servers.clankie.env_vars",
            "mcp_servers.clankie.default_tools_approval_mode",
            "mcp_servers.clankie.env.CLANKIE_EXPECTED_TOOL_NAMES",
            "mcp_servers.clankie.env.CLANKIE_EXPECTED_REQUIRED_TOOL_NAMES",
          ].includes(key)
        ),
      "native_codex_bridge_override_unproven",
    );
    overrides.set(key, JSON.parse(expression.slice(separator + 1)));
  }
  requireProof(
    overrides.get("mcp_servers.clankie.enabled") === true &&
      overrides.get("mcp_servers.clankie.command") === "clankie" &&
      same(overrides.get("mcp_servers.clankie.args"), ["mcp", "--fleet"]) &&
      same(overrides.get("mcp_servers.clankie.env_vars"), [
        "HERDR_PANE_ID",
        "HERDR_SOCKET_PATH",
        "CLANKIE_STATE",
      ]) &&
      // Current managed launches approve this bridge through Clankie's own
      // service gates. Earlier supported launches omitted the override.
      (!overrides.has("mcp_servers.clankie.default_tools_approval_mode") ||
        overrides.get("mcp_servers.clankie.default_tools_approval_mode") === "approve"),
    "original_codex_tui_bridge_not_managed_fleet",
  );
  return overrides;
}

/** Native process proof observes the original controller, never creates/resumes a thread. */
export async function observeLocalCodexCatalogIdentity(
  launch: LocalCodexRecord,
  signal?: AbortSignal,
): Promise<LocalCodexCatalogIdentity> {
  requireProof(process.platform === "darwin", "native_local_codex_refresh_proof_unavailable");
  signal?.throwIfAborted();
  const raw = object(
    await nativeRequest(
      launch.binding,
      "pane.process_info",
      { pane_id: launch.pane },
      { timeoutMs: 2_000, ...(signal ? { signal } : {}) },
    ),
  );
  const info = object(object(raw.result).process_info);
  requireProof(
    info.pane_id === launch.pane &&
      Number.isSafeInteger(info.shell_pid) &&
      info.foreground_process_group_id !== info.shell_pid,
    "original_native_pane_unavailable",
  );
  const occupants = (Array.isArray(info.foreground_processes) ? info.foreground_processes : [])
    .map(object)
    .filter(
      (row) =>
        Number.isSafeInteger(row.pid) &&
        Array.isArray(row.argv) &&
        row.argv.every((arg) => typeof arg === "string") &&
        basename(String(row.argv[0])) === "codex",
    );
  requireProof(occupants.length === 1, "original_codex_tui_ambiguous");
  const tui = occupants[0]!,
    argv = tui.argv as string[];
  const overrides = verifyLocalCodexCatalogOverrides(argv);
  const endpoint = argv[argv.indexOf("--remote") + 1];
  requireProof(
    argv.filter((arg) => arg === "--remote").length === 1 &&
      typeof endpoint === "string" &&
      isLocalCodexEndpoint(endpoint) &&
      (launch.endpoint === undefined || endpoint === launch.endpoint),
    "original_codex_endpoint_changed",
  );
  const resume = argv.indexOf("resume");
  const requestedThreadId = resume < 0 ? undefined : argv[resume + 1];
  requireProof(
    resume < 0 ||
      (typeof requestedThreadId === "string" &&
        requestedThreadId.length > 0 &&
        occupantIdForHerdrSession({ source: "herdr:codex", kind: "id", value: requestedThreadId }) ===
          launch.nativeOccupantId &&
        (launch.threadId === undefined || requestedThreadId === launch.threadId)),
    "original_codex_thread_changed",
  );
  const processProof = await observeNativeProcesses(
    Number(info.shell_pid),
    Number(tui.pid),
    undefined,
    undefined,
    signal,
  );
  requireProof(
    processProof?.processes.every((row) => row.uid === process.getuid?.()) &&
      basename(processProof.processes[1]!.executable) === "codex",
    "original_codex_birth_unavailable",
  );
  const alias = endpoint!.slice("unix://".length),
    directory = dirname(alias);
  const directoryStat = await lstat(directory),
    aliasStat = await lstat(alias),
    canonical = await realpath(alias),
    socketStat = await lstat(canonical);
  requireProof(
    directoryStat.isDirectory() &&
      !directoryStat.isSymbolicLink() &&
      directoryStat.uid === process.getuid?.() &&
      !(directoryStat.mode & 0o077) &&
      aliasStat.uid === process.getuid?.() &&
      (aliasStat.isSocket() || aliasStat.isSymbolicLink()) &&
      socketStat.isSocket() &&
      !socketStat.isSymbolicLink() &&
      socketStat.uid === process.getuid?.() &&
      !(socketStat.mode & 0o077),
    "original_private_codex_socket_unavailable",
  );
  const serverBirth = await observeCodexServer(launch.pid, endpoint!, canonical, signal);
  requireProof(
    serverBirth && nativeProcessReceipt(serverBirth, launch.start) === launch.start,
    "original_codex_server_birth_changed",
  );
  const shape = (stat: NonNullable<ReturnType<typeof lstatSync>>) => [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
  ];
  const assertCurrent = () => {
    signal?.throwIfAborted();
    requireProof(
      same(shape(lstatSync(directory)), shape(directoryStat)) &&
        same(shape(lstatSync(alias)), shape(aliasStat)) &&
        same(shape(lstatSync(canonical)), shape(socketStat)),
      "original_codex_socket_changed",
    );
  };
  assertCurrent();
  return {
    endpoint: endpoint!,
    ...(requestedThreadId === undefined ? {} : { requestedThreadId }),
    proof: {
      shellPid: info.shell_pid,
      shellBirth: processProof!.processes[0]!.birth,
      tuiPid: tui.pid,
      tuiBirth: processProof!.processes[1]!.birth,
      serverBirth,
      canonical,
      alias: shape(aliasStat),
      socket: shape(socketStat),
      overrides: [...overrides],
    },
    assertCurrent,
  };
}

async function privatePath(path: string, directory = false): Promise<void> {
  const stat = await lstat(path);
  requireProof(
    (directory ? stat.isDirectory() : stat.isFile()) &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid?.() &&
      !(stat.mode & 0o077) &&
      (await realpath(path)) === path,
    "codex_refresh_private_path_refused",
  );
}

/** Only native user-layer provenance authorizes the copied worker configuration. */
async function configuration(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  cwd: string,
  expectedHome?: string,
): Promise<ConfigProvenance> {
  const value = object(await request("config/read", { cwd, includeLayers: true }));
  requireProof(
    Array.isArray(value.layers) && value.layers.length <= 64,
    "native_codex_config_layers_unavailable",
  );
  const layers = (value.layers as unknown[]).map(object);
  const users = layers.filter(
    (layer) =>
      object(layer.name).type === "user" &&
      layer.disabledReason == null &&
      object(layer.name).profile == null,
  );
  requireProof(
    users.length === 1 && typeof object(users[0]!.name).file === "string" && revisionValid(users[0]!.version),
    "native_codex_user_layer_ambiguous",
  );
  const filePath = String(object(users[0]!.name).file),
    home = dirname(filePath);
  requireProof(
    isAbsolute(filePath) && (expectedHome === undefined || home === expectedHome),
    "original_codex_user_config_changed",
  );
  requireProof((await isolatedCodexConfig(home)) === filePath, "original_codex_config_not_isolated");
  await privatePath(filePath);
  const precedence: Record<string, number> = {
    packagedDefaults: -10,
    mdm: 0,
    system: 10,
    enterpriseManaged: 15,
    user: 20,
    project: 25,
    sessionFlags: 30,
    legacyManagedConfigTomlFromFile: 40,
    legacyManagedConfigTomlFromMdm: 50,
  };
  for (const layer of layers) {
    const name = object(layer.name),
      type = String(name.type);
    requireProof(
      Object.hasOwn(precedence, type) &&
        layer.config !== null &&
        typeof layer.config === "object" &&
        !Array.isArray(layer.config),
      "unknown_native_codex_config_layer",
    );
    requireProof(
      !(
        layer.disabledReason == null &&
        precedence[type]! + (type === "user" && name.profile != null ? 1 : 0) > 20 &&
        nested(layer.config, KEY.split(".")) !== undefined
      ),
      "codex_revision_masked_by_higher_layer",
    );
  }
  const effective = object(nested(value.config, ["mcp_servers", "clankie"]));
  requireProof(
    effective.enabled !== false &&
      effective.command === "clankie" &&
      same(effective.args, ["mcp", "--fleet"]),
    "native_codex_bridge_not_managed_fleet",
  );
  const env = object(effective.env),
    signalPath = env.CLANKIE_CODEX_CATALOG_SIGNAL;
  requireProof(
    signalPath === undefined || (typeof signalPath === "string" && isAbsolute(signalPath)),
    "native_codex_catalog_signal_invalid",
  );
  const revision = env.CLANKIE_CATALOG_REVISION;
  requireProof(revision === undefined || revisionValid(revision), "native_codex_revision_invalid");
  return {
    home,
    filePath,
    expectedVersion: String(users[0]!.version),
    ...(signalPath === undefined ? {} : { signalPath: String(signalPath) }),
    ...(revision === undefined ? {} : { value: String(revision) }),
  };
}

async function loadedThreads(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<string[]> {
  const loaded = object(await request("thread/loaded/list", {}));
  requireProof(
    Array.isArray(loaded.data) &&
      loaded.data.length > 0 &&
      loaded.data.length <= 64 &&
      loaded.data.every((id) => typeof id === "string") &&
      new Set(loaded.data).size === loaded.data.length &&
      loaded.nextCursor == null,
    "original_codex_loaded_scope_incomplete",
  );
  return [...(loaded.data as string[])].sort();
}

async function scope(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  root: string,
  onInventory?: (threads: ThreadScope[]) => void,
): Promise<ThreadScope[]> {
  const loaded = await loadedThreads(request);
  requireProof(loaded.includes(root), "original_codex_loaded_scope_incomplete");
  const threads: ThreadScope[] = [];
  for (const id of loaded) {
    const thread = object(object(await request("thread/read", { threadId: id, includeTurns: false })).thread);
    requireProof(
      thread.id === id && typeof thread.cwd === "string" && isAbsolute(thread.cwd),
      "original_codex_thread_metadata_unavailable",
    );
    const status = object(thread.status);
    requireProof(["idle", "active"].includes(String(status.type)), "original_codex_idle_state_unavailable");
    threads.push({
      id,
      cwd: String(thread.cwd),
      parentThreadId: id === root || typeof thread.parentThreadId !== "string" ? null : thread.parentThreadId,
      busy: status.type !== "idle",
    });
  }
  onInventory?.(threads);
  requireProof(
    threads.every((thread) => thread.id === root || thread.parentThreadId !== null),
    "independent_codex_loaded_root",
  );
  const parents = new Map(threads.map((row) => [row.id, row.parentThreadId]));
  for (const row of threads) {
    let id = row.id;
    const seen = new Set<string>();
    while (id !== root) {
      requireProof(
        !seen.has(id) && typeof parents.get(id) === "string",
        "codex_loaded_ancestry_unavailable_or_cyclic",
      );
      seen.add(id);
      id = parents.get(id)!;
    }
    row.cwd = await realpath(row.cwd);
  }
  return threads;
}

async function writeAttempt(path: string, attempt: Attempt): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`,
    file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(attempt));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
function writeDispatchIntent(path: string, attempt: Attempt): void {
  const temporary = `${path}.${randomUUID()}.tmp`,
    file = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(file, JSON.stringify(attempt));
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
async function readAttempt(path: string): Promise<Attempt | undefined> {
  try {
    await privatePath(path);
    const value = object(JSON.parse(await readFile(path, "utf8")));
    requireProof(
      value.version === 1 &&
        typeof value.originalProof === "string" &&
        /^[a-f0-9]{64}$/u.test(value.originalProof) &&
        revisionValid(value.revision) &&
        revisionValid(value.envRevision) &&
        typeof value.filePath === "string" &&
        revisionValid(value.expectedVersion) &&
        ["service", "operator"].includes(String(value.authorityKind)) &&
        Array.isArray(value.threads) &&
        value.threads.every((id) => typeof id === "string") &&
        ["writeDispatched", "writeConfirmed", "reloadDispatched", "reloadConfirmed", "verified"].every(
          (key) => typeof value[key] === "boolean",
        ),
      "codex_refresh_attempt_invalid",
    );
    return value as unknown as Attempt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function createLocalCodexCatalogCoordinator(input: {
  seats: LocalCodexSeats;
  /** Trusted service revision, independent of MCP schema changes. */
  revision?: string;
  onResult?: (result: LocalCodexCatalogResult) => void;
  /** Current service-owned tool projection, including optional fleet peer tools. */
  expectedTools?: () => readonly string[] | Promise<readonly string[]>;
  intervalMs?: number;
  /** Native process boundary only; protocol/filesystem integration fixtures inject owned identities. */
  observeIdentity?: typeof observeLocalCodexCatalogIdentity;
}) {
  let stopped = false,
    ticking = false,
    deployedRevision = input.revision;
  const busy = new Map<number, Promise<LocalCodexCatalogResult>>(),
    completed = new Map<string, string>();
  const retryAt = new Map<number, number>();
  const manualPending = new Map<number, LocalCodexCatalogRefreshInput>();
  const observe = input.observeIdentity ?? observeLocalCodexCatalogIdentity;
  const run = async (
    candidate: LocalCodexRecord,
    revision: string,
    authority: LocalCodexCatalogRefreshInput,
    reconcileOnly = false,
  ): Promise<LocalCodexCatalogResult> => {
    const { signal } = authority;
    const authorityKind =
      authority.beforeDispatch || authority.current ? ("operator" as const) : ("service" as const);
    const result: LocalCodexCatalogResult = {
      paneId: candidate.pane,
      ...(candidate.threadId === undefined ? {} : { threadId: candidate.threadId }),
      revision,
      outcome: "failed",
    };
    let client: CodexAppServerClient | undefined, releaseClaim: (() => Promise<void>) | undefined;
    try {
      requireProof(
        !stopped &&
          revisionValid(revision) &&
          candidate.binding.runtime === "external" &&
          isAbsolute(candidate.binding.socketPath),
        "managed_local_codex_refresh_unavailable",
      );
      const recordsPath = input.seats.catalogRecordsPath;
      requireProof(recordsPath, "durable_local_codex_registration_required");
      await privatePath(recordsPath!);
      await input.seats.guardCatalog(candidate, signal);
      const identity = await observe(candidate, signal);
      input.seats.assertCatalogCurrent(candidate);
      identity.assertCurrent();
      signal?.throwIfAborted();
      requireProof(
        isLocalCodexEndpoint(identity.endpoint) &&
          (candidate.endpoint === undefined || candidate.endpoint === identity.endpoint),
        "original_codex_endpoint_changed",
      );
      if (candidate.endpoint === undefined)
        candidate = input.seats.retainCatalogIdentity(candidate, { endpoint: identity.endpoint });
      const socket = await openCodexSocket(`ws+unix://${candidate.endpoint!.slice("unix://".length)}:/`);
      requireProof(socket, "original_codex_controller_unavailable");
      let activityEpoch = 0;
      client = new CodexAppServerClient(
        socket!,
        (event) => {
          if (
            event.method === "turn/started" ||
            event.method === "thread/started" ||
            event.method === "thread/closed" ||
            (event.method === "thread/status/changed" && object(event.params.status).type !== "idle")
          )
            activityEpoch++;
        },
        2_000,
      );
      const assertIdleObservation = () =>
        requireProof(activityEpoch === 0, "original_codex_refresh_became_busy");
      const abort = () => {
        client?.close();
        socket!.terminate();
      };
      signal?.addEventListener("abort", abort, { once: true });
      releaseClaim = async () => {
        signal?.removeEventListener("abort", abort);
      };
      await client.initialize(true);
      const request = async (method: string, params: Record<string, unknown>) => {
        signal?.throwIfAborted();
        if (stopped) throw new Error("codex_refresh_coordinator_closed");
        input.seats.assertCatalogCurrent(candidate);
        identity.assertCurrent();
        return client!.request(
          method,
          params,
          (method.startsWith("config/") && method !== "config/read") || method === "mcpServerStatus/list"
            ? 30_000
            : 2_000,
        );
      };
      if (candidate.threadId === undefined) {
        const roots = (await loadedThreads(request)).filter(
          (threadId) =>
            occupantIdForHerdrSession({ source: "herdr:codex", kind: "id", value: threadId }) ===
            candidate.nativeOccupantId,
        );
        requireProof(roots.length === 1, "original_codex_registered_thread_unavailable");
        requireProof(
          identity.requestedThreadId === undefined || identity.requestedThreadId === roots[0],
          "original_codex_registered_thread_changed",
        );
        candidate = input.seats.retainCatalogIdentity(candidate, {
          endpoint: identity.endpoint,
          threadId: roots[0]!,
        });
      }
      requireProof(
        occupantIdForHerdrSession({ source: "herdr:codex", kind: "id", value: candidate.threadId! }) ===
          candidate.nativeOccupantId &&
          (identity.requestedThreadId === undefined || identity.requestedThreadId === candidate.threadId),
        "original_codex_registered_thread_changed",
      );
      result.threadId = candidate.threadId!;
      const readScope = async () => {
        let detail: string | undefined;
        try {
          return await scope(request, candidate.threadId!, (threads) => {
            detail = `Loaded native threads: ${JSON.stringify(threads)}`.slice(0, 2048);
          });
        } catch (error) {
          if (detail) result.detail = detail;
          throw error;
        }
      };
      const threads = await readScope();
      if (threads.some((thread) => thread.busy))
        return { ...result, outcome: "skipped-busy", reason: "original_codex_thread_or_descendant_busy" };
      const configs: ConfigProvenance[] = [];
      for (const cwd of new Set(threads.map((thread) => thread.cwd)))
        configs.push(await configuration(request, cwd, candidate.catalogConfig?.home));
      const config = configs[0]!;
      requireProof(
        configs.every(
          (row) => row.filePath === config.filePath && row.expectedVersion === config.expectedVersion,
        ),
        "original_codex_user_versions_conflict",
      );
      const provenance = {
        home: config.home,
        filePath: config.filePath,
        ...(config.signalPath === undefined ? {} : { signalPath: config.signalPath }),
      };
      if (candidate.catalogConfig === undefined)
        candidate = input.seats.retainCatalogConfig(candidate, provenance);
      else
        requireProof(same(candidate.catalogConfig, provenance), "original_codex_config_provenance_changed");
      const directory = join(dirname(recordsPath!), "codex-catalog-refresh");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await privatePath(directory, true);
      const identityKey = hash({
        pane: candidate.pane,
        pid: candidate.pid,
        start: candidate.start,
        thread: candidate.threadId,
        endpoint: candidate.endpoint,
        binding: candidate.binding,
        occupant: candidate.nativeOccupantId,
      });
      const path = join(directory, `${identityKey}.json`),
        lockPath = `${path}.claim`;
      let claimHeld = false;
      const claim = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST" && reconcileOnly) {
          claimHeld = true;
          return undefined;
        }
        if (error.code === "EEXIST") throw new Error("original_codex_refresh_in_progress");
        throw error;
      });
      if (claim) {
        const previousRelease = releaseClaim;
        releaseClaim = async () => {
          await previousRelease?.();
          await unlink(lockPath);
        };
        try {
          await claim.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
          await claim.sync();
        } finally {
          await claim.close();
        }
      } else {
        await privatePath(lockPath);
      }
      // Reconciliation changes durable state too. Own the same claim before
      // reading a prior attempt, so another service cannot replace it while
      // this observer is verifying and settling the original receipt.
      const prior = await readAttempt(path);
      if (prior)
        requireProof(
          prior.originalProof === hash(identity.proof),
          "original_codex_durable_controller_proof_changed",
        );
      const observeCatalogs = async () => {
        const expectedTools = [...new Set((await input.expectedTools?.()) ?? REQUIRED_TOOLS)].sort();
        requireProof(
          expectedTools.length <= 128 &&
            expectedTools.every((name) => typeof name === "string" && /^[a-z][a-z0-9_]*$/u.test(name)),
          "trusted_codex_catalog_expectations_unavailable",
        );
        const inventory: { threadId: string; tools: string[] }[] = [];
        const observations: {
          threadId: string;
          verified: boolean;
          runtimeStatus?: string;
          error?: string;
          toolsError?: string;
          missing: string[];
          unexpected: string[];
        }[] = [];
        for (const thread of threads) {
          let native: { runtimeStatus?: string; toolsError?: string } = {};
          const report = await codexToolCatalogReport({
            sessionId: thread.id,
            request,
            requireConnected: true,
            onServerStatus: (status) => {
              native = status;
            },
          });
          observations.push({
            threadId: thread.id,
            verified: !report.error && same([...new Set(report.tools)].sort(), expectedTools),
            ...native,
            ...(report.error ? { error: report.error } : {}),
            missing: expectedTools.filter((name) => !report.tools.includes(name)),
            unexpected: report.tools.filter((name) => !expectedTools.includes(name)),
          });
          inventory.push({ threadId: thread.id, tools: report.tools });
        }
        result.detail = `Original native catalogs: ${JSON.stringify(observations)}`.slice(0, 2048);
        return {
          inventory,
          verified: observations.every((row) => row.verified),
          // Unknown/absent/timed-out status or a connected wrong catalog does
          // not authorize another mutation. A failed native runtime does.
          failedStartup:
            observations.some((row) => row.runtimeStatus === "failed") &&
            observations.every((row) => row.verified || row.runtimeStatus === "failed"),
        };
      };
      const catalogs = async () => {
        const observed = await observeCatalogs();
        requireProof(observed.verified, "original_codex_catalog_unverified");
        return observed.inventory;
      };
      const catalogRefreshed = (
        inventory: { threadId: string; tools: string[] }[],
        confirmedRevision = revision,
      ): LocalCodexCatalogResult => ({
        ...result,
        revision: confirmedRevision,
        outcome: "catalog-refreshed",
        reason: "original_codex_next_turn_tools_unverified",
        detail:
          `Original MCP catalog refreshed; next model turn tools and new report delivery require a native worker check. ${result.detail ?? ""}`.slice(
            0,
            2048,
          ),
        catalogs: inventory,
      });
      if (claimHeld) {
        const observed = await catalogs();
        await guard(config.expectedVersion, config.value);
        return {
          ...result,
          reason: "original_codex_refresh_claim_held_readonly_observed",
          catalogs: observed,
        };
      }
      let resumeConfirmedWrite = false;
      let replaceConfirmedFailure = false;
      if (prior && !prior.verified && (prior.writeDispatched || prior.reloadDispatched)) {
        // Observation can settle a confirmed reload's missing verification. An
        // unconfirmed mutation is never reissued, even under a newer revision.
        if (
          prior.reloadConfirmed &&
          prior.writeConfirmed &&
          config.value === prior.envRevision &&
          config.expectedVersion === prior.writtenVersion &&
          same(
            prior.threads,
            threads.map((row) => row.id),
          )
        ) {
          const observed = await observeCatalogs();
          await guard(prior.writtenVersion!, prior.envRevision);
          if (observed.verified) {
            prior.verified = true;
            await writeAttempt(path, prior);
            if (prior.revision === revision) return catalogRefreshed(observed.inventory, prior.revision);
          } else {
            requireProof(!reconcileOnly && observed.failedStartup, "original_codex_catalog_unverified");
            requireProof(
              prior.authorityKind !== "operator" || authorityKind === "operator",
              "original_codex_operator_refresh_requires_current_operator",
            );
            replaceConfirmedFailure = true;
          }
        } else if (
          prior.writeConfirmed &&
          !prior.reloadDispatched &&
          config.value === prior.envRevision &&
          config.expectedVersion === prior.writtenVersion &&
          same(
            prior.threads,
            threads.map((row) => row.id),
          )
        ) {
          requireProof(
            reconcileOnly || prior.authorityKind !== "operator" || authorityKind === "operator",
            "original_codex_operator_refresh_requires_current_operator",
          );
          resumeConfirmedWrite = true;
        } else {
          const observed = reconcileOnly ? await catalogs() : undefined;
          if (reconcileOnly) await guard(config.expectedVersion, config.value);
          return {
            ...result,
            reason: "original_codex_refresh_delivery_unconfirmed_readonly_reconciliation_required",
            ...(observed === undefined ? {} : { catalogs: observed }),
          };
        }
      }
      if (
        prior?.verified &&
        prior.revision === revision &&
        config.value === prior.envRevision &&
        config.expectedVersion === prior.writtenVersion &&
        same(
          prior.threads,
          threads.map((row) => row.id),
        )
      ) {
        const observed = await observeCatalogs();
        await guard(prior.writtenVersion!, prior.envRevision);
        if (observed.verified) return catalogRefreshed(observed.inventory);
        requireProof(!reconcileOnly && observed.failedStartup, "original_codex_catalog_unverified");
        requireProof(
          prior.authorityKind !== "operator" || authorityKind === "operator",
          "original_codex_operator_refresh_requires_current_operator",
        );
        replaceConfirmedFailure = true;
      }
      if (reconcileOnly) {
        const observed = await catalogs();
        await guard(config.expectedVersion, config.value);
        return {
          ...result,
          reason: "original_codex_refresh_native_mutation_required",
          catalogs: observed,
        };
      }
      const attempt: Attempt = resumeConfirmedWrite
        ? prior!
        : {
            version: 1,
            originalProof: hash(identity.proof),
            revision,
            envRevision: randomUUID(),
            filePath: config.filePath,
            expectedVersion: config.expectedVersion,
            threads: threads.map((row) => row.id),
            writeDispatched: false,
            writeConfirmed: false,
            reloadDispatched: false,
            reloadConfirmed: false,
            verified: false,
            authorityKind,
          };
      if (!resumeConfirmedWrite) {
        // Retain the fully acknowledged failed generation before installing
        // a fresh env revision. Never overwrite an uncertain mutation journal.
        if (replaceConfirmedFailure)
          await writeAttempt(`${path}.${prior!.envRevision}.confirmed-failure.json`, prior!);
        await writeAttempt(path, attempt);
      }
      async function guard(version: string, expectedRevision?: string) {
        try {
          await authority.beforeDispatch?.();
        } catch {
          throw new Error("codex_refresh_operator_authority_changed");
        }
        requireProof(authority.current?.() !== false, "codex_refresh_operator_authority_changed");
        assertIdleObservation();
        await input.seats.guardCatalog(candidate, signal);
        for (const cwd of new Set(threads.map((row) => row.cwd))) {
          const current = await configuration(request, cwd, config.home);
          requireProof(
            current.filePath === config.filePath && current.expectedVersion === version,
            "original_codex_config_version_changed",
          );
          if (expectedRevision !== undefined)
            requireProof(current.value === expectedRevision, "original_codex_effective_revision_changed");
        }
        const freshThreads = await readScope();
        requireProof(
          same(freshThreads, threads),
          freshThreads.some((row) => row.busy)
            ? "original_codex_refresh_became_busy"
            : "original_codex_loaded_scope_changed",
        );
        const freshIdentity = await observe(candidate, signal);
        requireProof(same(freshIdentity.proof, identity.proof), "original_codex_controller_identity_changed");
        input.seats.assertCatalogCurrent(candidate);
        freshIdentity.assertCurrent();
        identity.assertCurrent();
        signal?.throwIfAborted();
        assertIdleObservation();
        requireProof(authority.current?.() !== false, "codex_refresh_operator_authority_changed");
      }
      if (!resumeConfirmedWrite) {
        await guard(config.expectedVersion);
        attempt.writeDispatched = true;
        writeDispatchIntent(path, attempt);
        input.seats.assertCatalogCurrent(candidate);
        identity.assertCurrent();
        signal?.throwIfAborted();
        assertIdleObservation();
        requireProof(authority.current?.() !== false, "codex_refresh_operator_authority_changed");
        const written = object(
          await request("config/value/write", {
            keyPath: KEY,
            value: attempt.envRevision,
            mergeStrategy: "upsert",
            filePath: config.filePath,
            expectedVersion: config.expectedVersion,
          }),
        );
        requireProof(
          written.status === "ok" &&
            written.filePath === config.filePath &&
            written.overriddenMetadata == null &&
            revisionValid(written.version),
          "original_codex_config_write_unconfirmed",
        );
        attempt.writeConfirmed = true;
        attempt.writtenVersion = String(written.version);
        await writeAttempt(path, attempt);
      }
      await guard(attempt.writtenVersion!, attempt.envRevision);
      attempt.reloadDispatched = true;
      writeDispatchIntent(path, attempt);
      input.seats.assertCatalogCurrent(candidate);
      identity.assertCurrent();
      signal?.throwIfAborted();
      assertIdleObservation();
      requireProof(authority.current?.() !== false, "codex_refresh_operator_authority_changed");
      await request("config/mcpServer/reload", {});
      attempt.reloadConfirmed = true;
      await writeAttempt(path, attempt);
      const inventory = await catalogs();
      await guard(attempt.writtenVersion!, attempt.envRevision);
      attempt.verified = true;
      await writeAttempt(path, attempt);
      return catalogRefreshed(inventory, attempt.revision);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "original_codex_refresh_unconfirmed";
      return {
        ...result,
        ...(["original_codex_refresh_became_busy", "original_codex_refresh_in_progress"].includes(reason)
          ? { outcome: "skipped-busy" as const }
          : {}),
        reason: /^[a-z][a-z0-9_]{1,160}$/u.test(reason)
          ? reason
          : "original_codex_refresh_native_or_filesystem_unconfirmed",
      };
    } finally {
      client?.close();
      await releaseClaim?.().catch(() => undefined);
    }
  };
  const refreshSeats = async (
    options: LocalCodexCatalogRefreshInput,
    reconcileOnly = false,
  ): Promise<LocalCodexCatalogResult[]> => {
    const candidates = input.seats.catalogCandidates(options.paneId),
      results: LocalCodexCatalogResult[] = [];
    for (const candidate of candidates) {
      if (busy.has(candidate.pid)) {
        if (!reconcileOnly && (options.beforeDispatch || options.current))
          manualPending.set(candidate.pid, options);
        results.push({
          paneId: candidate.pane,
          ...(candidate.threadId === undefined ? {} : { threadId: candidate.threadId }),
          revision: options.revision,
          outcome: "skipped-busy",
          reason: "original_codex_refresh_in_progress",
        });
        continue;
      }
      const pending = run(candidate, options.revision, options, reconcileOnly);
      busy.set(candidate.pid, pending);
      try {
        const result = await pending;
        results.push(result);
        if (result.outcome === "catalog-refreshed") completed.set(hash(candidate), result.revision);
        const queued = manualPending.get(candidate.pid);
        if (!reconcileOnly && (queued === undefined || queued === options)) {
          if (result.outcome === "skipped-busy" && (options.beforeDispatch || options.current))
            manualPending.set(candidate.pid, options);
          else manualPending.delete(candidate.pid);
        }
        retryAt.set(candidate.pid, Date.now() + (result.outcome === "failed" ? 30_000 : 0));
        input.onResult?.(result);
      } finally {
        busy.delete(candidate.pid);
      }
    }
    return results;
  };
  const refresh = (options: LocalCodexCatalogRefreshInput) => {
    if (!options.beforeDispatch && !options.current) deployedRevision = options.revision;
    return refreshSeats(options);
  };
  const tick = async () => {
    if (stopped || ticking || (deployedRevision === undefined && manualPending.size === 0)) return;
    ticking = true;
    try {
      for (const candidate of input.seats.catalogCandidates()) {
        try {
          if ((retryAt.get(candidate.pid) ?? 0) > Date.now()) continue;
          const manual = manualPending.get(candidate.pid);
          if (manual) {
            const retry = { ...manual, paneId: candidate.pane };
            manualPending.set(candidate.pid, retry);
            await refreshSeats(retry);
            continue;
          }
          if (deployedRevision === undefined) continue;
          let revision = deployedRevision;
          const signalPath = candidate.catalogConfig?.signalPath;
          if (signalPath) {
            const stat = await lstat(signalPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            });
            if (stat !== undefined)
              requireProof(
                stat.isFile() &&
                  !stat.isSymbolicLink() &&
                  stat.uid === process.getuid?.() &&
                  stat.size <= 64 &&
                  dirname(signalPath) === dirname(candidate.endpoint!.slice("unix://".length)),
                "invalid_codex_catalog_signal_path",
              );
            const signal = await readFile(signalPath, "utf8").catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            });
            if (signal !== undefined) {
              requireProof(/^[a-f0-9-]{36}$/u.test(signal), "invalid_codex_catalog_signal");
              revision = `${deployedRevision}:${signal}`;
            }
          }
          if (completed.get(hash(candidate)) !== revision)
            await refreshSeats({ paneId: candidate.pane, revision });
        } catch (error) {
          const reason = error instanceof Error ? error.message : "original_codex_catalog_signal_unavailable";
          retryAt.set(candidate.pid, Date.now() + 30_000);
          input.onResult?.({
            paneId: candidate.pane,
            ...(candidate.threadId === undefined ? {} : { threadId: candidate.threadId }),
            revision: deployedRevision ?? "unknown",
            outcome: "failed",
            reason: /^[a-z][a-z0-9_]{1,160}$/u.test(reason)
              ? reason
              : "original_codex_catalog_signal_unavailable",
          });
        }
      }
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), input.intervalMs ?? 1_000);
  timer.unref();
  return {
    refresh,
    close() {
      stopped = true;
      clearInterval(timer);
    },
    reconcile: (options: LocalCodexCatalogRefreshInput) => refreshSeats(options, true),
  };
}
