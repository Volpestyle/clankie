import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, open, readdir, realpath } from "node:fs/promises";
import { createServer, request as requestHttp, type IncomingMessage, type Server } from "node:http";
import { connect, isIP } from "node:net";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import type { EventStore } from "@clankie/event-store";
import type { ActionDecision, ActionRequest, Risk } from "@clankie/protocol";
export interface SandboxRunIdentity {
  missionId: string;
  taskId: string;
  workerRunId: string;
  profileHash: string;
  risk: Risk;
  workspacePath: string;
}
export interface SandboxEscalation {
  networkHosts?: string[];
  networkTargets?: Array<{ host: string; port: number }>;
  additionalWritableRoots?: string[];
  /** When present, replace ambient host reads with this positive root set. */
  readableRoots?: string[];
  /** Trusted module entrypoints whose bounded package runtime closures must also be readable. */
  runtimeReadEntries?: string[];
  bypass?: boolean;
}
export interface SandboxDenial {
  operation: "filesystem" | "network" | "policy" | "platform";
  reason: string;
  targetFingerprint?: string;
}
export interface PreparedSandbox {
  command: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  profile: "restricted" | "elevated" | "bypass";
  collectDenials(signal?: NodeJS.Signals): Promise<SandboxDenial[]>;
  close(): Promise<void>;
}
export interface ShellSandboxOptions {
  events?: EventStore;
  decideEscalation?: (request: ActionRequest) => Promise<ActionDecision>;
  platform?: NodeJS.Platform;
  executable?: string;
  clock?: () => Date;
  idFactory?: () => string;
}
export class SandboxPreparationError extends Error {
  public readonly denial: SandboxDenial;
  public constructor(denial: SandboxDenial) {
    super(denial.reason);
    this.name = "SandboxPreparationError";
    this.denial = denial;
  }
}
/**
 * Builds a fail-closed macOS Seatbelt invocation. Direct egress is denied.
 * Exact HTTP(S) host allowlists flow through a runner-owned localhost proxy,
 * whose single port is the only network destination visible to the worker.
 */
export class ShellSandbox {
  private readonly options: Required<
    Pick<ShellSandboxOptions, "platform" | "executable" | "clock" | "idFactory">
  > &
    Pick<ShellSandboxOptions, "events" | "decideEscalation">;
  public constructor(options: ShellSandboxOptions = {}) {
    this.options = {
      ...options,
      platform: options.platform ?? process.platform,
      executable: options.executable ?? "/usr/bin/sandbox-exec",
      clock: options.clock ?? (() => new Date()),
      idFactory: options.idFactory ?? randomUUID,
    };
  }
  public async prepare(
    identity: SandboxRunIdentity,
    invocation: { command: string; args: string[] },
    environment: NodeJS.ProcessEnv,
    requested: SandboxEscalation = {},
  ): Promise<PreparedSandbox> {
    if (requested.readableRoots === undefined) {
      return this.prepareInternal(identity, invocation, environment, requested);
    }
    const workspace = await realpath(identity.workspacePath);
    const lexicalWorkspace = resolve(identity.workspacePath);
    const resolvedInvocation = await resolveInvocation(invocation, environment, workspace);
    const readableRoots = await resolvePositiveReadRoots(requested.readableRoots);
    const runtimeReadRoots = await resolveRuntimeReadEntries(requested.runtimeReadEntries ?? []);
    return this.prepareInternal(identity, resolvedInvocation.invocation, environment, requested, [
      lexicalWorkspace,
      workspace,
      ...SANDBOX_SYSTEM_READ_ROOTS,
      ...resolvedInvocation.readRoots,
      ...readableRoots,
      ...runtimeReadRoots,
    ]);
  }

  /**
   * Verification executes candidate-controlled code with a narrower read boundary than a general worker.
   * Only the candidate, its explicitly declared dependency inputs, and the resolved tool runtime are readable.
   */
  public async prepareVerification(
    identity: SandboxRunIdentity,
    invocation: { command: string; args: string[] },
    environment: NodeJS.ProcessEnv,
    dependencyRoots: readonly string[] = [],
  ): Promise<PreparedSandbox> {
    const workspace = await realpath(identity.workspacePath);
    const resolvedInvocation = await resolveInvocation(invocation, environment, workspace);
    const dependencies = await resolveDependencyRoots(dependencyRoots, environment, workspace);
    return this.prepareInternal(
      identity,
      resolvedInvocation.invocation,
      buildVerificationEnvironment(environment, workspace),
      {},
      [workspace, ...SANDBOX_SYSTEM_READ_ROOTS, ...resolvedInvocation.readRoots, ...dependencies],
    );
  }

  private async prepareInternal(
    identity: SandboxRunIdentity,
    invocation: { command: string; args: string[] },
    environment: NodeJS.ProcessEnv,
    requested: SandboxEscalation,
    readableRoots?: readonly string[],
  ): Promise<PreparedSandbox> {
    const workspace = await realpath(identity.workspacePath);
    const networkHosts = [...new Set((requested.networkHosts ?? []).map(normalizeHost))].sort();
    const networkTargets = [
      ...new Map(
        (requested.networkTargets ?? []).map((target) => {
          const normalized = { host: normalizeHost(target.host), port: normalizePort(target.port) };
          return [`${normalized.host}:${normalized.port}`, normalized] as const;
        }),
      ).values(),
    ].sort((left, right) => `${left.host}:${left.port}`.localeCompare(`${right.host}:${right.port}`));
    const additionalRoots = await Promise.all(
      [...new Set(requested.additionalWritableRoots ?? [])].map((path) => realpath(path)),
    );
    const escalated =
      requested.bypass === true ||
      networkHosts.length > 0 ||
      networkTargets.length > 0 ||
      additionalRoots.length > 0;
    if (escalated)
      await this.authorize(identity, {
        ...requested,
        networkHosts,
        networkTargets,
        additionalWritableRoots: additionalRoots,
      });
    if (requested.bypass === true) {
      return {
        ...invocation,
        environment,
        profile: "bypass",
        collectDenials: () => Promise.resolve([]),
        close: () => Promise.resolve(),
      };
    }
    if (this.options.platform !== "darwin") {
      throw new SandboxPreparationError({
        operation: "platform",
        reason: `No enforced shell sandbox is available on ${this.options.platform}`,
      });
    }
    try {
      await access(this.options.executable, constants.X_OK);
    } catch {
      throw new SandboxPreparationError({
        operation: "platform",
        reason: "The configured macOS sandbox executable is unavailable",
      });
    }
    const proxy =
      networkHosts.length > 0 || networkTargets.length > 0
        ? await AllowlistProxy.start(networkHosts, networkTargets)
        : undefined;
    const writableRoots = [workspace, ...additionalRoots];
    const profile = buildSeatbeltProfile(writableRoots, proxy?.port, readableRoots);
    const proxyUrl = proxy ? `http://[::1]:${String(proxy.port)}` : undefined;
    return {
      command: this.options.executable,
      args: ["-p", profile, invocation.command, ...invocation.args],
      environment: {
        ...environment,
        ...(proxyUrl
          ? {
              HTTP_PROXY: proxyUrl,
              HTTPS_PROXY: proxyUrl,
              http_proxy: proxyUrl,
              https_proxy: proxyUrl,
              NO_PROXY: "",
              no_proxy: "",
            }
          : {}),
      },
      profile: escalated ? "elevated" : "restricted",
      collectDenials: async (signal) => [
        ...(proxy?.denials ?? []),
        ...(signal === "SIGKILL"
          ? [
              {
                operation: "policy" as const,
                reason: "macOS Seatbelt force-terminated a prohibited operation",
              },
            ]
          : []),
      ],
      close: () => proxy?.close() ?? Promise.resolve(),
    };
  }
  private async authorize(identity: SandboxRunIdentity, requested: SandboxEscalation): Promise<void> {
    if (!this.options.events || !this.options.decideEscalation) {
      throw new SandboxPreparationError({
        operation: "policy",
        reason: "Sandbox escalation requires both a doctrine gateway and durable audit sink",
      });
    }
    const request: ActionRequest = {
      id: `sandbox-${this.options.idFactory()}`,
      principal: { kind: "worker", id: identity.workerRunId },
      action: requested.bypass === true ? "runner.sandbox.bypass" : "runner.sandbox.escalate",
      resource: { type: "worker_sandbox", id: identity.workerRunId },
      context: {
        missionId: identity.missionId,
        taskId: identity.taskId,
        risk: identity.risk,
        profileHash: identity.profileHash,
      },
    };
    const decision = await this.options.decideEscalation(request);
    await this.options.events.append({
      id: this.options.idFactory(),
      occurredAt: this.options.clock().toISOString(),
      missionId: identity.missionId,
      taskId: identity.taskId,
      workerRunId: identity.workerRunId,
      correlationId: identity.workerRunId,
      profileHash: identity.profileHash,
      type: "sandbox.escalation.decided",
      data: {
        action: request.action,
        effect: decision.effect,
        reason: decision.reason,
        matchedPolicyIds: decision.matchedPolicyIds,
        obligations: decision.obligations,
        networkHostFingerprints: (requested.networkHosts ?? []).map(fingerprint),
        networkTargetFingerprints: (requested.networkTargets ?? []).map((target) =>
          fingerprint(`${target.host}:${target.port}`),
        ),
        writableRootFingerprints: (requested.additionalWritableRoots ?? []).map(fingerprint),
      },
    });
    if (decision.obligations.length > 0) {
      throw new SandboxPreparationError({
        operation: "policy",
        reason: "Sandbox escalation returned obligations the runner cannot enforce",
      });
    }
    if (decision.effect !== "allow") {
      throw new SandboxPreparationError({
        operation: "policy",
        reason: `Sandbox escalation ${decision.effect}: ${decision.reason}`,
      });
    }
  }
}

function buildVerificationEnvironment(environment: NodeJS.ProcessEnv, workspace: string): NodeJS.ProcessEnv {
  const restricted: NodeJS.ProcessEnv = {
    ...environment,
    HOME: workspace,
    TMPDIR: workspace,
    TMP: workspace,
    TEMP: workspace,
    OPENSSL_CONF: "/dev/null",
  };
  delete restricted.CODEX_HOME;
  delete restricted.XDG_CONFIG_HOME;
  delete restricted.XDG_CACHE_HOME;
  return restricted;
}

const SANDBOX_SYSTEM_READ_ROOTS = [
  "/System/Library",
  "/System/Volumes/Preboot/Cryptexes",
  "/Library/Apple",
  "/usr/lib",
  "/usr/share",
  "/private/etc/ssl",
  "/private/etc/localtime",
  "/private/var/db/timezone",
  "/dev/null",
  "/dev/dtracehelper",
  "/dev/urandom",
] as const;

async function resolveInvocation(
  invocation: { command: string; args: string[] },
  environment: NodeJS.ProcessEnv,
  workspace: string,
): Promise<{ invocation: { command: string; args: string[] }; readRoots: string[] }> {
  const executable = await resolveExecutable(invocation.command, environment, workspace);
  const executables = new Set<string>();
  await collectExecutableRuntime(executable, environment, workspace, executables, 0);
  return {
    invocation: { command: executable, args: invocation.args },
    readRoots: (
      await Promise.all([...executables].map(async (path) => [path, ...(await toolRuntimeRoots(path))]))
    ).flat(),
  };
}

async function collectExecutableRuntime(
  executable: string,
  environment: NodeJS.ProcessEnv,
  workspace: string,
  executables: Set<string>,
  depth: number,
): Promise<void> {
  if (executables.has(executable) || depth > 3) return;
  executables.add(executable);
  const shebang = await readShebang(executable);
  if (!shebang) return;
  const [interpreter, ...arguments_] = shebang.split(/\s+/u);
  if (!interpreter) return;
  const resolvedInterpreter = await resolveExecutable(interpreter, environment, workspace);
  await collectExecutableRuntime(resolvedInterpreter, environment, workspace, executables, depth + 1);
  if (resolvedInterpreter.endsWith("/env")) {
    const envCommand = arguments_.find((argument) => !argument.startsWith("-"));
    if (envCommand) {
      const resolvedEnvCommand = await resolveExecutable(envCommand, environment, workspace);
      await collectExecutableRuntime(resolvedEnvCommand, environment, workspace, executables, depth + 1);
    }
  }
}

async function readShebang(path: string): Promise<string | undefined> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    return firstLine?.startsWith("#!") ? firstLine.slice(2).trim() : undefined;
  } finally {
    await handle.close();
  }
}

async function resolveExecutable(
  command: string,
  environment: NodeJS.ProcessEnv,
  workspace: string,
): Promise<string> {
  const candidates =
    isAbsolute(command) || command.includes(sep)
      ? [resolve(workspace, command)]
      : (environment.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin")
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => resolve(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through the trusted PATH without exposing candidate paths in evidence.
    }
  }
  throw new SandboxPreparationError({
    operation: "platform",
    reason: "The configured verification executable is unavailable",
  });
}

async function toolRuntimeRoots(executable: string): Promise<string[]> {
  const cellar = /^(.*\/Cellar\/[^/]+\/[^/]+)(?:\/|$)/u.exec(executable)?.[1];
  if (cellar) {
    const cellarRoot = /^(.*\/Cellar)(?:\/|$)/u.exec(cellar)?.[1];
    if (!cellarRoot) return [cellar];
    const prefix = cellarRoot.slice(0, -"/Cellar".length);
    return [cellar, cellarRoot, join(prefix, "opt"), join(prefix, "lib")];
  }
  const pnpmVirtualPackage = /^(.*\/node_modules\/\.pnpm)\/[^/]+\/(node_modules)(?:\/|$)/u.exec(executable);
  if (pnpmVirtualPackage) return discoverPnpmRuntimeRoots(pnpmVirtualPackage[0]!.replace(/\/$/u, ""));
  const nodeModule = /^(.*\/lib\/node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/u.exec(executable)?.[1];
  return [nodeModule ?? dirname(executable)];
}

async function discoverPnpmRuntimeRoots(initialNodeModules: string): Promise<string[]> {
  const pnpmStoreRoot = /^(.*\/node_modules\/\.pnpm)\/[^/]+\/node_modules$/u.exec(initialNodeModules)?.[1];
  if (!pnpmStoreRoot) throw pnpmRuntimeUnexpectedEntry();
  const nodeModulesQueue = [{ path: initialNodeModules, depth: 0 }];
  const visitedNodeModules = new Set<string>();
  const runtimeRoots = new Set<string>();
  let entryCount = 0;
  while (nodeModulesQueue.length > 0) {
    const { path: nodeModules, depth } = nodeModulesQueue.shift()!;
    if (visitedNodeModules.has(nodeModules)) continue;
    if (depth > 32 || visitedNodeModules.size >= 1_024) throw pnpmRuntimeOverflow();
    visitedNodeModules.add(nodeModules);
    runtimeRoots.add(nodeModules);
    let entries;
    try {
      entries = await readdir(nodeModules, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > 4_096 || runtimeRoots.size > 2_048) throw pnpmRuntimeOverflow();
      if (entry.name === ".bin") continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) throw pnpmRuntimeUnexpectedEntry();
      const entryPath = join(nodeModules, entry.name);
      if (entry.name.startsWith("@")) {
        if (!/^@[A-Za-z0-9._-]+$/u.test(entry.name) || !entry.isDirectory())
          throw pnpmRuntimeUnexpectedEntry();
        for (const scopedEntry of await readdir(entryPath, { withFileTypes: true })) {
          entryCount += 1;
          if (
            entryCount > 4_096 ||
            !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(scopedEntry.name) ||
            (!scopedEntry.isDirectory() && !scopedEntry.isSymbolicLink())
          )
            throw pnpmRuntimeUnexpectedEntry();
          await addPnpmPackageRoot(
            join(entryPath, scopedEntry.name),
            runtimeRoots,
            nodeModulesQueue,
            depth,
            pnpmStoreRoot,
          );
        }
        continue;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.name)) throw pnpmRuntimeUnexpectedEntry();
      await addPnpmPackageRoot(entryPath, runtimeRoots, nodeModulesQueue, depth, pnpmStoreRoot);
    }
  }
  return [...runtimeRoots];
}

async function addPnpmPackageRoot(
  packagePath: string,
  runtimeRoots: Set<string>,
  nodeModulesQueue: Array<{ path: string; depth: number }>,
  depth: number,
  pnpmStoreRoot: string,
): Promise<void> {
  try {
    const canonicalPackage = await realpath(packagePath);
    const packageNodeModules = /^(.*\/node_modules)(?:\/@[^/]+)?\/[^/]+$/u.exec(canonicalPackage)?.[1];
    if (!packageNodeModules || !isWithin(canonicalPackage, pnpmStoreRoot)) {
      throw pnpmRuntimeUnexpectedEntry();
    }
    runtimeRoots.add(canonicalPackage);
    nodeModulesQueue.push({ path: packageNodeModules, depth: depth + 1 });
  } catch {
    throw pnpmRuntimeUnexpectedEntry();
  }
}

function pnpmRuntimeOverflow(): SandboxPreparationError {
  return new SandboxPreparationError({
    operation: "policy",
    reason: "The pnpm runtime dependency graph exceeds the bounded sandbox discovery budget",
  });
}

function pnpmRuntimeUnexpectedEntry(): SandboxPreparationError {
  return new SandboxPreparationError({
    operation: "policy",
    reason: "The pnpm runtime dependency graph contains an unexpected entry",
  });
}

async function resolveDependencyRoots(
  roots: readonly string[],
  environment: NodeJS.ProcessEnv,
  workspace: string,
): Promise<string[]> {
  const home = environment.HOME ? await canonicalizeExisting(environment.HOME) : undefined;
  const sensitiveRoots = [
    environment.CODEX_HOME,
    environment.XDG_CONFIG_HOME,
    environment.XDG_CACHE_HOME,
    home ? join(home, ".clankie") : undefined,
  ].filter((path): path is string => Boolean(path));
  const resolvedRoots: string[] = [];
  for (const root of roots) {
    if (!isAbsolute(root)) {
      throw new SandboxPreparationError({
        operation: "policy",
        reason: "Verification dependency roots must be absolute",
      });
    }
    const canonical = await realpath(root);
    if (isWithin(canonical, workspace)) continue;
    if (
      (home && (isWithin(canonical, home) || isWithin(home, canonical))) ||
      sensitiveRoots.some((sensitive) => isWithin(canonical, sensitive) || isWithin(sensitive, canonical))
    ) {
      throw new SandboxPreparationError({
        operation: "policy",
        reason: "Verification dependency root overlaps runner-private state",
      });
    }
    resolvedRoots.push(canonical);
  }
  return [...new Set(resolvedRoots)];
}

async function resolvePositiveReadRoots(roots: readonly string[]): Promise<string[]> {
  const resolvedRoots: string[] = [];
  for (const root of new Set(roots)) {
    if (!isAbsolute(root)) {
      throw new SandboxPreparationError({
        operation: "policy",
        reason: "Sandbox positive read roots must be absolute",
      });
    }
    try {
      const lexical = resolve(root);
      resolvedRoots.push(lexical, await realpath(lexical));
    } catch {
      throw new SandboxPreparationError({
        operation: "policy",
        reason: "A sandbox positive read root is unavailable",
      });
    }
  }
  return [...new Set(resolvedRoots)];
}

async function resolveRuntimeReadEntries(entries: readonly string[]): Promise<string[]> {
  const roots: string[] = [];
  for (const entry of new Set(entries)) {
    if (!isAbsolute(entry)) {
      throw new SandboxPreparationError({
        operation: "policy",
        reason: "Sandbox runtime read entries must be absolute",
      });
    }
    try {
      const canonical = await realpath(entry);
      roots.push(resolve(entry), canonical, ...(await toolRuntimeRoots(canonical)));
    } catch {
      throw new SandboxPreparationError({
        operation: "policy",
        reason: "A sandbox runtime read entry is unavailable or unsafe",
      });
    }
  }
  return [...new Set(roots)];
}

async function canonicalizeExisting(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function isWithin(path: string, root: string): boolean {
  const relativePath = relative(root, path);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`));
}

function buildSeatbeltProfile(
  writableRoots: string[],
  proxyPort?: number,
  readableRoots?: readonly string[],
): string {
  const writeFilters = [
    `(literal "/dev/null")`,
    `(literal "/dev/dtracehelper")`,
    `(literal "/dev/tty")`,
    ...writableRoots.map((path) => `(subpath ${JSON.stringify(path)})`),
  ];
  const denyOutsideWrites = writeFilters.map((filter) => `(require-not ${filter})`).join(" ");
  const readFilters = readableRoots
    ? [
        `(literal "/")`,
        ...[...new Set(readableRoots)].flatMap((path) => [
          `(literal ${JSON.stringify(path)})`,
          `(subpath ${JSON.stringify(path)})`,
        ]),
      ]
    : [];
  const metadataFilters = readableRoots
    ? [...new Set(readableRoots.flatMap(parentPaths))].map((path) => `(literal ${JSON.stringify(path)})`)
    : [];
  const allowedNetworkEndpoints = proxyPort === undefined ? [] : [`localhost:${String(proxyPort)}`];
  const networkFilters = [
    ...allowedNetworkEndpoints.map((endpoint) => `(remote ip ${JSON.stringify(endpoint)})`),
    `(literal "/private/var/run/syslog")`,
  ];
  const networkFilter = networkFilters.map((filter) => ` (require-not ${filter})`).join("");
  return [
    "(version 1)",
    "(deny default)",
    `(deny file-write* (require-all ${denyOutsideWrites}) (with send-signal SIGKILL))`,
    `(deny network-outbound${networkFilter} (with send-signal SIGKILL))`,
    `(deny network-outbound (literal "/private/var/run/syslog"))`,
    "(allow process-exec process-fork)",
    "(allow sysctl-read)",
    ...(readableRoots
      ? [
          `(allow file-read* ${readFilters.join(" ")})`,
          `(allow file-read-metadata ${metadataFilters.join(" ")})`,
        ]
      : ["(allow file-read*)"]),
    `(allow file-write* ${writeFilters.join(" ")})`,
    ...allowedNetworkEndpoints.map(
      (endpoint) => `(allow network-outbound (remote ip ${JSON.stringify(endpoint)}))`,
    ),
  ].join("\n");
}

function parentPaths(path: string): string[] {
  const paths: string[] = [];
  let current = resolve(path);
  while (true) {
    paths.push(current);
    const parent = dirname(current);
    if (parent === current) return paths;
    current = parent;
  }
}

function listenServer(
  server: Server,
  options: { port: number; host: string; ipv6Only?: boolean },
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return Promise.resolve();
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

class AllowlistProxy {
  public readonly denials: SandboxDenial[] = [];
  public readonly port: number;
  private readonly allowedHosts: Set<string>;
  private readonly allowedTargets: Set<string>;
  private readonly servers: Server[];

  private constructor(
    servers: Server[],
    port: number,
    hosts: string[],
    targets: Array<{ host: string; port: number }>,
  ) {
    this.servers = servers;
    this.port = port;
    this.allowedHosts = new Set(hosts);
    this.allowedTargets = new Set(targets.map((target) => `${target.host}:${target.port}`));
  }

  public static async start(
    hosts: string[],
    targets: Array<{ host: string; port: number }>,
  ): Promise<AllowlistProxy> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      let proxy: AllowlistProxy | undefined;
      const servers = ["::1", "127.0.0.1"].map(() => {
        const server = createServer((request, response) => void proxy?.forwardHttp(request, response));
        server.on("connect", (request, socket, head) => proxy?.forwardConnect(request, socket, head));
        return server;
      });
      try {
        await listenServer(servers[0]!, { port: 0, host: "::1", ipv6Only: true });
        const address = servers[0]!.address();
        if (!address || typeof address === "string") throw new Error("Allowlist proxy did not bind TCP");
        await listenServer(servers[1]!, { port: address.port, host: "127.0.0.1" });
        proxy = new AllowlistProxy(servers, address.port, hosts, targets);
        return proxy;
      } catch (error) {
        await Promise.all(servers.map(closeServer));
        if (attempt === 15) throw error;
      }
    }
    throw new Error("Allowlist proxy could not reserve both loopback families");
  }

  public async close(): Promise<void> {
    await Promise.all(this.servers.map(closeServer));
  }

  private forwardHttp(request: IncomingMessage, response: import("node:http").ServerResponse): void {
    let target: URL;
    try {
      target = new URL(request.url ?? "");
      if (target.protocol !== "http:") throw new Error("unsupported protocol");
    } catch {
      this.deny("invalid-target", response);
      return;
    }
    const targetHost = normalizeHost(target.hostname);
    const targetPort = normalizePort(Number(target.port || 80));
    if (!this.isAllowed(targetHost, targetPort)) {
      this.deny(target.hostname, response);
      return;
    }
    const headers: Record<string, string | string[] | undefined> = {
      ...request.headers,
      host: target.host,
    };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = requestHttp(
      {
        hostname: target.hostname,
        port: targetPort,
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => response.writeHead(502).end());
    request.pipe(upstream);
  }

  private forwardConnect(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    let target: URL;
    try {
      target = new URL(`http://${request.url ?? ""}`);
    } catch {
      this.denySocket("invalid-target", socket);
      return;
    }
    const targetHost = normalizeHost(target.hostname);
    const targetPort = normalizePort(Number(target.port || 443));
    if (!this.isAllowed(targetHost, targetPort)) {
      this.denySocket(target.hostname, socket);
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (this.allowedTargets.has(`${targetHost}:${targetPort}`)) {
      const upstream = connect(targetPort, targetHost, () => {
        if (head.length > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
      return;
    }
    let buffered = head;
    const timeout = setTimeout(() => rejectTls("TLS ClientHello timed out"), 5_000);
    const onData = (chunk: Buffer | string) => {
      buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (buffered.length > 64 * 1024) {
        rejectTls("TLS ClientHello exceeded the proxy limit");
        return;
      }
      const hello = parseTlsServerName(buffered);
      if (hello.status === "need_more") return;
      if (hello.status === "invalid" || (isIP(targetHost) === 0 && hello.serverName !== targetHost)) {
        rejectTls("TLS server name does not match the allowlisted CONNECT host");
        return;
      }
      clearTimeout(timeout);
      socket.removeListener("data", onData);
      socket.pause();
      const upstream = connect(targetPort, targetHost, () => {
        upstream.write(buffered);
        upstream.pipe(socket);
        socket.pipe(upstream);
        socket.resume();
      });
      upstream.on("error", () => socket.destroy());
    };
    const rejectTls = (reason: string) => {
      clearTimeout(timeout);
      socket.removeListener("data", onData);
      this.denials.push({ operation: "network", reason, targetFingerprint: fingerprint(targetHost) });
      socket.destroy();
    };
    socket.on("data", onData);
    if (head.length > 0) onData(Buffer.alloc(0));
  }

  private isAllowed(host: string, port: number): boolean {
    return this.allowedHosts.has(host) || this.allowedTargets.has(`${host}:${port}`);
  }

  private deny(target: string, response: import("node:http").ServerResponse): void {
    this.denials.push({
      operation: "network",
      reason: "Host is not in the sandbox allowlist",
      targetFingerprint: fingerprint(normalizeHost(target)),
    });
    response.writeHead(403, { "content-type": "text/plain" }).end("sandbox network denial\n");
  }

  private denySocket(target: string, socket: Duplex): void {
    this.denials.push({
      operation: "network",
      reason: "Host is not in the sandbox allowlist",
      targetFingerprint: fingerprint(normalizeHost(target)),
    });
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  }
}

export type TlsServerNameResult =
  | { status: "need_more" }
  | { status: "invalid" }
  | { status: "ok"; serverName?: string };

export function parseTlsServerName(buffer: Buffer): TlsServerNameResult {
  if (buffer.length < 5) return { status: "need_more" };
  if (buffer[0] !== 22) return { status: "invalid" };
  const recordLength = buffer.readUInt16BE(3);
  if (buffer.length < 5 + recordLength) return { status: "need_more" };
  let offset = 5;
  if (buffer[offset] !== 1 || recordLength < 4) return { status: "invalid" };
  const handshakeLength = buffer.readUIntBE(offset + 1, 3);
  if (handshakeLength + 4 > recordLength) return { status: "invalid" }; // fragmented ClientHello: deny
  offset += 4 + 2 + 32;
  if (offset >= buffer.length) return { status: "invalid" };
  offset += 1 + (buffer[offset] ?? 0); // session id
  if (offset + 2 > buffer.length) return { status: "invalid" };
  const cipherLength = buffer.readUInt16BE(offset);
  offset += 2 + cipherLength;
  if (offset >= buffer.length) return { status: "invalid" };
  offset += 1 + (buffer[offset] ?? 0); // compression methods
  if (offset === 5 + recordLength) return { status: "ok" };
  if (offset + 2 > buffer.length) return { status: "invalid" };
  const extensionsEnd = offset + 2 + buffer.readUInt16BE(offset);
  offset += 2;
  if (extensionsEnd > 5 + recordLength) return { status: "invalid" };
  while (offset + 4 <= extensionsEnd) {
    const type = buffer.readUInt16BE(offset);
    const length = buffer.readUInt16BE(offset + 2);
    offset += 4;
    if (offset + length > extensionsEnd) return { status: "invalid" };
    if (type === 0) {
      if (length < 5 || offset + 5 > extensionsEnd || buffer[offset + 2] !== 0) {
        return { status: "invalid" };
      }
      const nameLength = buffer.readUInt16BE(offset + 3);
      if (offset + 5 + nameLength > extensionsEnd) return { status: "invalid" };
      try {
        return {
          status: "ok",
          serverName: normalizeHost(buffer.subarray(offset + 5, offset + 5 + nameLength).toString("ascii")),
        };
      } catch {
        return { status: "invalid" };
      }
    }
    offset += length;
  }
  return { status: "ok" };
}

function normalizeHost(host: string): string {
  const normalized = host.trim().toLowerCase().replace(/\.$/u, "");
  const unbracketed =
    normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
  if (isIP(unbracketed) === 0 && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(unbracketed)) {
    throw new Error("Invalid network allowlist host");
  }
  return unbracketed;
}

function normalizePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid network allowlist port");
  return port;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
