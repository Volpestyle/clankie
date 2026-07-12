import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ClaudeWorkerAdapter, CLAUDE_AGENT_SDK_VERSION } from "@clankie/worker-claude";
import { CodexWorkerAdapter, probeCodexToolBoundary } from "@clankie/worker-codex";
import {
  PiWorkerAdapter,
  PiRpcClient,
  PI_CODING_AGENT_VERSION,
  resolveBundledPiRpcEntry,
  type PiProcessPreparer,
} from "@clankie/worker-pi";
import type { WorkerAdapter, WorkerRunContext } from "@clankie/worker-sdk";
import type { PreparedSandbox, SandboxEscalation, SandboxRunIdentity } from "./sandbox.ts";

const execFileAsync = promisify(execFile);

export type ProviderName = "codex" | "claude" | "pi";

export interface ProviderMetadata {
  provider: ProviderName;
  version: string;
}

export interface ProviderReadinessIssue {
  code: string;
  message: string;
}

export interface ProviderReadinessReport {
  provider: ProviderName;
  workerId: string;
  status: "disabled" | "ready" | "unavailable";
  issues: ProviderReadinessIssue[];
}

export interface ReadyProviderFleet {
  adapters: WorkerAdapter[];
  metadata: ReadonlyMap<string, ProviderMetadata>;
  reports: ProviderReadinessReport[];
}

export interface ProviderFactoryOptions {
  environment: NodeJS.ProcessEnv;
  workerEnvironment: NodeJS.ProcessEnv;
  runnerStateRoot: string;
  sandbox?: {
    prepare(
      identity: SandboxRunIdentity,
      invocation: { command: string; args: string[] },
      environment: NodeJS.ProcessEnv,
      requested?: SandboxEscalation,
    ): Promise<PreparedSandbox>;
  };
  probes?: {
    executable?: (command: string, environment: NodeJS.ProcessEnv) => Promise<string>;
    isolation?: () => Promise<boolean>;
    codexAuth?: (command: string, codexHome: string, environment: NodeJS.ProcessEnv) => Promise<boolean>;
    codexBoundary?: (input: {
      command: string;
      environment: NodeJS.ProcessEnv;
      toolEnvironment: NodeJS.ProcessEnv;
      deniedReadPaths: string[];
    }) => Promise<boolean>;
    claudeAuth?: (environment: NodeJS.ProcessEnv, configDirectory: string) => Promise<boolean>;
    ollamaModels?: (url: URL) => Promise<string[]>;
    piBoundary?: (input: {
      command: string;
      environment: NodeJS.ProcessEnv;
      workspacePath: string;
      processPreparer: PiProcessPreparer;
      model: string;
      ollamaUrl: URL;
      sessionRoot: string;
    }) => Promise<boolean>;
  };
}

/** Builds only providers whose complete executable/auth/model/isolation gate passes. */
export async function createReadyProviderFleet(options: ProviderFactoryOptions): Promise<ReadyProviderFleet> {
  const adapters: WorkerAdapter[] = [];
  const metadata = new Map<string, ProviderMetadata>();
  const reports = await Promise.all([
    prepareCodex(options, adapters, metadata),
    prepareClaude(options, adapters, metadata),
    preparePi(options, adapters, metadata),
  ]);
  return { adapters, metadata, reports };
}

async function prepareCodex(
  options: ProviderFactoryOptions,
  adapters: WorkerAdapter[],
  metadata: Map<string, ProviderMetadata>,
): Promise<ProviderReadinessReport> {
  const workerId = "codex-implementation";
  if (!enabled(options.environment.CLANKIE_CODEX_ENABLED)) return disabled("codex", workerId);
  const issues: ProviderReadinessIssue[] = [];
  const model = requireSetting(options.environment.CLANKIE_CODEX_MODEL, "model_not_configured", issues);
  const command = options.environment.CLANKIE_CODEX_EXECUTABLE?.trim() || "codex";
  const version = await probeExecutable(options, command, issues);
  const codexHome = options.workerEnvironment.CODEX_HOME?.trim();
  if (!codexHome) {
    issues.push({
      code: "auth_home_not_configured",
      message: "Set CODEX_HOME to an authenticated Codex home.",
    });
  } else {
    const authFile = await validateCodexAuthFile(codexHome);
    if (authFile.status === "unavailable") {
      issues.push({
        code: "auth_file_unavailable",
        message: "Configure a private file-backed CODEX_HOME/auth.json.",
      });
    } else if (authFile.status === "invalid") {
      issues.push({
        code: "auth_file_invalid",
        message: "Re-authenticate Codex to replace the malformed configured auth document.",
      });
    } else {
      const authenticated = await (options.probes?.codexAuth ?? defaultCodexAuth)(
        command,
        codexHome,
        options.workerEnvironment,
      );
      if (!authenticated) {
        issues.push({
          code: "auth_unavailable",
          message: "Authenticate Codex in the configured CODEX_HOME.",
        });
      } else {
        const afterProbe = await validateCodexAuthFile(codexHome);
        if (afterProbe.status !== "valid" || afterProbe.identity !== authFile.identity) {
          issues.push({
            code: "auth_file_unavailable",
            message: "Codex auth state changed during the bounded readiness probe.",
          });
        }
      }
    }
  }
  await requireIsolation(options, issues);
  const toolHome = providerToolHome(options, "codex");
  await preparePrivateDirectory(toolHome);
  const toolEnvironment = buildToolEnvironment(options.workerEnvironment, toolHome);
  const deniedReadPaths = providerPrivatePaths(options, [codexHome]);
  const boundaryReady = await (options.probes?.codexBoundary ?? defaultCodexBoundary)({
    command,
    environment: options.workerEnvironment,
    toolEnvironment,
    deniedReadPaths,
  });
  if (!boundaryReady) {
    issues.push({
      code: "tool_boundary_unavailable",
      message: "Install a Codex App Server that accepts the strict named deny-read profile.",
    });
  }
  if (issues.length > 0 || !model || !version) return unavailable("codex", workerId, issues);
  const adapter = new CodexWorkerAdapter({
    id: workerId,
    displayName: "Codex implementation",
    kinds: ["implementation", "integration"],
    command,
    model,
    environment: options.workerEnvironment,
    toolEnvironment,
    deniedReadPaths,
  });
  adapters.push(adapter);
  metadata.set(workerId, { provider: "codex", version });
  return ready("codex", workerId);
}

async function prepareClaude(
  options: ProviderFactoryOptions,
  adapters: WorkerAdapter[],
  metadata: Map<string, ProviderMetadata>,
): Promise<ProviderReadinessReport> {
  const workerId = "claude-verification";
  if (!enabled(options.environment.CLANKIE_CLAUDE_ENABLED)) return disabled("claude", workerId);
  const issues: ProviderReadinessIssue[] = [];
  const model = requireSetting(options.environment.CLANKIE_CLAUDE_MODEL, "model_not_configured", issues);
  const command = requireSetting(
    options.environment.CLANKIE_CLAUDE_EXECUTABLE,
    "executable_not_configured",
    issues,
  );
  const executableVersion = command ? await probeExecutable(options, command, issues) : undefined;
  const stateRoot = join(options.runnerStateRoot, "providers", "claude");
  const toolHome = providerToolHome(options, "claude");
  const configDirectory = options.environment.CLAUDE_CONFIG_DIR?.trim() || join(stateRoot, "config");
  await Promise.all([preparePrivateDirectory(toolHome), preparePrivateDirectory(configDirectory)]);
  const claudeEnvironment = buildClaudeEnvironment(
    buildToolEnvironment(options.workerEnvironment, toolHome),
    options.environment,
    configDirectory,
  );
  if (!(await (options.probes?.claudeAuth ?? defaultClaudeAuth)(claudeEnvironment, configDirectory))) {
    issues.push({
      code: "auth_unavailable",
      message:
        "Configure an Anthropic API key, complete Bedrock environment credentials, or complete Vertex ADC configuration; consumer OAuth is not accepted.",
    });
  }
  await requireIsolation(options, issues);
  if (issues.length > 0 || !model || !command || !executableVersion) {
    return unavailable("claude", workerId, issues);
  }
  const protectedFiles = providerPrivatePaths(options, [
    configDirectory,
    options.environment.GOOGLE_APPLICATION_CREDENTIALS,
  ]);
  const adapter = new ClaudeWorkerAdapter({
    id: workerId,
    displayName: "Claude verification",
    kinds: ["verification", "review"],
    model,
    environment: claudeEnvironment,
    pathToClaudeCodeExecutable: command,
    settingSources: [],
    credentialFiles: protectedFiles,
    requireCredentialBoundary: true,
  });
  const readOnly: WorkerAdapter = {
    descriptor: {
      ...adapter.descriptor,
      capabilities: { ...adapter.descriptor.capabilities, canWrite: false },
    },
    run: (context) => adapter.run(context),
  };
  adapters.push(readOnly);
  metadata.set(workerId, {
    provider: "claude",
    version: `${CLAUDE_AGENT_SDK_VERSION}+${executableVersion}`,
  });
  return ready("claude", workerId);
}

async function preparePi(
  options: ProviderFactoryOptions,
  adapters: WorkerAdapter[],
  metadata: Map<string, ProviderMetadata>,
): Promise<ProviderReadinessReport> {
  const workerId = "pi-debugging";
  if (!enabled(options.environment.CLANKIE_PI_ENABLED)) return disabled("pi", workerId);
  const issues: ProviderReadinessIssue[] = [];
  const model = requireSetting(options.environment.CLANKIE_PI_MODEL, "model_not_configured", issues);
  const command = resolvePiExecutable();
  const version = await probeExecutable(options, command, issues);
  await requireIsolation(options, issues);
  if (!options.sandbox) {
    issues.push({
      code: "sandbox_not_configured",
      message: "Configure the runner-owned Pi process sandbox and audit sink.",
    });
  }
  const ollamaUrl = parseLoopbackOllamaUrl(options.environment.CLANKIE_PI_OLLAMA_URL, issues);
  if (ollamaUrl && model) {
    try {
      const models = await (options.probes?.ollamaModels ?? defaultOllamaModels)(ollamaUrl);
      if (!models.includes(model)) {
        issues.push({
          code: "model_unavailable",
          message: "Pull the configured Pi model into local Ollama.",
        });
      }
    } catch {
      issues.push({
        code: "ollama_unreachable",
        message: "Start the configured localhost Ollama service and verify its model endpoint.",
      });
    }
  }
  if (issues.length > 0 || !model || !version || !ollamaUrl || !options.sandbox) {
    return unavailable("pi", workerId, issues);
  }

  const stateRoot = join(options.runnerStateRoot, "providers", "pi");
  const home = join(stateRoot, "home");
  const configDirectory = join(stateRoot, "config");
  const sessionRoot = join(stateRoot, "sessions");
  await preparePiState({ home, configDirectory, sessionRoot, model, ollamaUrl });
  const piEnvironment: NodeJS.ProcessEnv = {
    ...options.workerEnvironment,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    PI_CODING_AGENT_DIR: configDirectory,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    OPENSSL_CONF: "/dev/null",
    TMPDIR: join(home, "tmp"),
    TMP: join(home, "tmp"),
    TEMP: join(home, "tmp"),
  };
  delete piEnvironment.CODEX_HOME;
  const piPathRoots = await sanitizedPathReadRoots(piEnvironment.PATH, [
    options.workerEnvironment.HOME,
    options.workerEnvironment.CODEX_HOME,
    options.runnerStateRoot,
  ]);
  piEnvironment.PATH = piPathRoots.join(delimiter);
  const sandbox = options.sandbox;
  const processPreparer = createPiProcessPreparer({
    sandbox,
    stateRoot,
    readableRoots: [stateRoot, home, configDirectory, sessionRoot, ...piPathRoots],
    ollamaUrl,
  });
  const readinessWorkspace = join(stateRoot, "readiness-workspace");
  await mkdir(readinessWorkspace, { recursive: true, mode: 0o700 });
  const piBoundaryReady = await (options.probes?.piBoundary ?? defaultPiBoundary)({
    command,
    environment: piEnvironment,
    workspacePath: readinessWorkspace,
    processPreparer,
    model,
    ollamaUrl,
    sessionRoot,
  });
  if (!piBoundaryReady) {
    issues.push({
      code: "tool_boundary_unavailable",
      message: "Pi could not start from the positive read-root process sandbox.",
    });
    return unavailable("pi", workerId, issues);
  }
  const adapter = new PiWorkerAdapter({
    id: workerId,
    displayName: "Pi debugging",
    kinds: ["debugging"],
    command,
    rpcEntry: true,
    provider: "ollama",
    model,
    environment: piEnvironment,
    sessionRoot,
    processPreparer,
  });
  adapters.push(adapter);
  metadata.set(workerId, { provider: "pi", version: PI_CODING_AGENT_VERSION });
  return ready("pi", workerId);
}

export async function probePiBoundary(input: {
  command: string;
  environment: NodeJS.ProcessEnv;
  workspacePath: string;
  processPreparer: PiProcessPreparer;
  model: string;
  ollamaUrl: URL;
  sessionRoot: string;
}): Promise<boolean> {
  const run = {
    missionId: "provider-readiness",
    workerRunId: "pi-readiness",
    task: {
      id: "pi-readiness",
      title: "Probe Pi runtime boundary",
      objective: "Initialize pinned Pi RPC and its exact configured local model inside the sandbox.",
      kind: "debugging",
      role: "debugger",
      dependsOn: [],
      executionClass: "automatic",
      risk: "low",
      writeScope: [],
      successCriteria: ["Pi RPC state binds the configured local model."],
      evidenceRequirements: ["bounded RPC state and model response"],
      maxAttempts: 1,
      metadata: {},
    },
    workspacePath: input.workspacePath,
    profileHash: "provider-readiness",
    attempt: 1,
    signal: new AbortController().signal,
    emit: () => undefined,
  } satisfies WorkerRunContext;
  let networkProbe: Awaited<ReturnType<PiProcessPreparer>> | undefined;
  let client: PiRpcClient | undefined;
  try {
    networkProbe = await input.processPreparer({
      command: process.execPath,
      args: [
        "--input-type=module",
        "--eval",
        `const { configureHttpDispatcher } = await import(process.argv[1]);
configureHttpDispatcher();
const response = await fetch(process.argv[2], { signal: AbortSignal.timeout(3000) });
if (!response.ok) process.exit(2);
process.stdout.write(JSON.stringify(await response.json()));`,
        pathToFileURL(join(dirname(resolveBundledPiRpcEntry()), "core", "http-dispatcher.js")).href,
        new URL("/api/tags", input.ollamaUrl).toString(),
      ],
      environment: input.environment,
      cwd: input.workspacePath,
      run,
    });
    const { stdout } = await execFileAsync(networkProbe.command, networkProbe.args, {
      cwd: input.workspacePath,
      env: networkProbe.environment,
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    });
    const tags: unknown = JSON.parse(stdout);
    if (!ollamaTagsContain(tags, input.model)) return false;
    client = await PiRpcClient.create(input.workspacePath, run, {
      command: input.command,
      rpcEntry: true,
      provider: "ollama",
      model: input.model,
      sessionDirectory: input.sessionRoot,
      environment: input.environment,
      timeoutMs: 5_000,
      processPreparer: input.processPreparer,
    });
    return await client.readiness("ollama", input.model, input.sessionRoot, 5_000);
  } catch {
    return false;
  } finally {
    await client?.close().catch(() => undefined);
    await networkProbe?.close?.().catch(() => undefined);
  }
}

const defaultPiBoundary = probePiBoundary;

function ollamaTagsContain(value: unknown, model: string): boolean {
  if (!isRecord(value) || !Array.isArray(value.models)) return false;
  return value.models.some((entry) => isRecord(entry) && (entry.name === model || entry.model === model));
}

export function createPiProcessPreparer(input: {
  sandbox: NonNullable<ProviderFactoryOptions["sandbox"]>;
  stateRoot: string;
  readableRoots: string[];
  ollamaUrl: URL;
}): PiProcessPreparer {
  return async (process) => {
    const prepared = await input.sandbox.prepare(
      {
        missionId: process.run.missionId,
        taskId: process.run.task.id,
        workerRunId: process.run.workerRunId,
        profileHash: process.run.profileHash,
        risk: process.run.task.risk,
        workspacePath: process.cwd,
      },
      { command: process.command, args: process.args },
      process.environment,
      {
        networkTargets: [{ host: input.ollamaUrl.hostname, port: Number(input.ollamaUrl.port || 80) }],
        additionalWritableRoots: [input.stateRoot],
        readableRoots: input.readableRoots,
        runtimeReadEntries: [resolveBundledPiRpcEntry()],
      },
    );
    return {
      command: prepared.command,
      args: prepared.args,
      environment: prepared.environment,
      close: prepared.close,
    };
  };
}

function buildClaudeEnvironment(
  base: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv,
  configDirectory: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base, CLAUDE_CONFIG_DIR: configDirectory };
  for (const name of [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CLOUD_ML_REGION",
    "ANTHROPIC_VERTEX_PROJECT_ID",
  ]) {
    if (source[name]) environment[name] = source[name];
  }
  return environment;
}

async function preparePiState(input: {
  home: string;
  configDirectory: string;
  sessionRoot: string;
  model: string;
  ollamaUrl: URL;
}): Promise<void> {
  const privateDirectories = [
    input.home,
    join(input.home, "tmp"),
    join(input.home, ".config"),
    join(input.home, ".cache"),
    input.configDirectory,
    input.sessionRoot,
  ];
  await Promise.all(privateDirectories.map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  await Promise.all(privateDirectories.map((path) => chmod(path, 0o700)));
  const baseUrl = new URL("/v1", input.ollamaUrl).toString().replace(/\/$/u, "");
  await writeJsonIfChanged(join(input.configDirectory, "models.json"), {
    providers: {
      ollama: {
        baseUrl,
        api: "openai-completions",
        apiKey: "ollama-local-no-secret",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: input.model }],
      },
    },
  });
  await writeJsonIfChanged(join(input.configDirectory, "settings.json"), {
    enableInstallTelemetry: false,
    quietStartup: true,
  });
}

async function preparePrivateDirectory(path: string): Promise<void> {
  await Promise.all([
    mkdir(path, { recursive: true, mode: 0o700 }),
    mkdir(join(path, "tmp"), { recursive: true, mode: 0o700 }),
  ]);
  await chmod(path, 0o700);
  await chmod(join(path, "tmp"), 0o700);
}

function buildToolEnvironment(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    TMPDIR: join(home, "tmp"),
    TMP: join(home, "tmp"),
    TEMP: join(home, "tmp"),
  };
  for (const name of [
    "PATH",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
  ]) {
    if (base[name]) environment[name] = base[name];
  }
  return environment;
}

function providerPrivatePaths(
  options: ProviderFactoryOptions,
  additional: Array<string | undefined>,
): string[] {
  const home = options.workerEnvironment.HOME?.trim();
  const homePrivate = home
    ? [".ssh", ".aws", ".config", ".codex", ".claude", ".gnupg", ".kube", ".netrc", ".npmrc"].map((name) =>
        join(home, name),
      )
    : [];
  return [...new Set([options.runnerStateRoot, ...homePrivate, ...additional].filter(Boolean) as string[])];
}

function providerToolHome(options: ProviderFactoryOptions, provider: ProviderName): string {
  return join(`${options.runnerStateRoot}-tool-homes`, provider);
}

async function sanitizedPathReadRoots(
  pathValue: string | undefined,
  deniedValues: Array<string | undefined>,
): Promise<string[]> {
  const deniedRoots = deniedValues
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => resolve(value));
  const roots: string[] = [];
  for (const candidate of new Set((pathValue ?? "").split(delimiter).filter(Boolean))) {
    if (!isAbsolute(candidate)) continue;
    try {
      const canonical = await realpath(candidate);
      if (deniedRoots.some((denied) => isWithinPath(canonical, denied) || isWithinPath(denied, canonical))) {
        continue;
      }
      roots.push(canonical);
    } catch {
      // Missing and unreadable PATH entries are not part of the positive contract.
    }
  }
  return [...new Set(roots)];
}

function isWithinPath(path: string, root: string): boolean {
  const relativePath = relative(root, path);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`));
}

async function writeJsonIfChanged(path: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    // The runner creates provider state on first readiness success.
  }
  if (existing === serialized) return;
  const temporary = `${path}.tmp-${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
  await import("node:fs/promises").then(({ rename }) => rename(temporary, path));
}

function resolvePiExecutable(): string {
  return resolveBundledPiRpcEntry();
}

function parseLoopbackOllamaUrl(
  value: string | undefined,
  issues: ProviderReadinessIssue[],
): URL | undefined {
  if (!value?.trim()) {
    issues.push({
      code: "ollama_url_not_configured",
      message: "Set CLANKIE_PI_OLLAMA_URL to an exact localhost HTTP endpoint.",
    });
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname) ||
      url.username ||
      url.password ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search ||
      url.hash
    ) {
      throw new Error("not exact loopback HTTP");
    }
    return url;
  } catch {
    issues.push({
      code: "ollama_url_invalid",
      message: "Use an exact HTTP localhost Ollama origin without credentials, path, query, or fragment.",
    });
    return undefined;
  }
}

async function probeExecutable(
  options: ProviderFactoryOptions,
  command: string,
  issues: ProviderReadinessIssue[],
): Promise<string | undefined> {
  try {
    return await (options.probes?.executable ?? defaultExecutableProbe)(command, options.workerEnvironment);
  } catch {
    issues.push({ code: "executable_unavailable", message: "Install or configure the provider executable." });
    return undefined;
  }
}

async function requireIsolation(
  options: ProviderFactoryOptions,
  issues: ProviderReadinessIssue[],
): Promise<void> {
  if (!(await (options.probes?.isolation ?? defaultIsolationProbe)())) {
    issues.push({
      code: "isolation_unavailable",
      message: "Install a supported enforced process sandbox before enabling this provider.",
    });
  }
}

async function defaultExecutableProbe(command: string, environment: NodeJS.ProcessEnv): Promise<string> {
  await access(command, constants.X_OK).catch(async () => {
    const { stdout } = await execFileAsync("/usr/bin/env", ["which", command], {
      env: environment,
      timeout: 5_000,
    });
    await access(stdout.trim(), constants.X_OK);
  });
  const { stdout, stderr } = await execFileAsync(command, ["--version"], {
    env: environment,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  const version = `${stdout}${stderr}`
    .trim()
    .split("\n", 1)[0]
    ?.replace(/[^A-Za-z0-9._+-]+/gu, "-");
  if (!version) throw new Error("version unavailable");
  return version.slice(0, 120);
}

async function defaultIsolationProbe(): Promise<boolean> {
  if (process.platform === "darwin")
    return access("/usr/bin/sandbox-exec", constants.X_OK).then(
      () => true,
      () => false,
    );
  if (process.platform === "linux") {
    return execFileAsync("/usr/bin/env", ["which", "bwrap"], { timeout: 5_000 }).then(
      ({ stdout }) => Boolean(stdout.trim()),
      () => false,
    );
  }
  return false;
}

async function defaultCodexAuth(
  command: string,
  codexHome: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    await execFileAsync(command, ["-c", 'cli_auth_credentials_store="file"', "login", "status"], {
      env: { ...environment, CODEX_HOME: codexHome },
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

type CodexAuthFileResult =
  | { status: "valid"; identity: string }
  | { status: "invalid" }
  | { status: "unavailable" };

async function validateCodexAuthFile(codexHome: string): Promise<CodexAuthFileResult> {
  const path = join(codexHome, "auth.json");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size === 0 ||
      metadata.size > 1024 * 1024 ||
      (metadata.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) {
      return { status: "unavailable" };
    }
    const content = await handle.readFile({ encoding: "utf8" });
    const value: unknown = JSON.parse(content);
    return validCodexAuthDocument(value)
      ? {
          status: "valid",
          identity: `${String(metadata.dev)}:${String(metadata.ino)}:${createHash("sha256").update(content).digest("hex")}`,
        }
      : { status: "invalid" };
  } catch (error) {
    if (isNodeError(error) && error.code && ["ENOENT", "EACCES", "EPERM", "ELOOP"].includes(error.code)) {
      return { status: "unavailable" };
    }
    return { status: "invalid" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validCodexAuthDocument(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!optionalString(value.OPENAI_API_KEY) || !optionalString(value.personal_access_token)) return false;
  if (value.last_refresh !== undefined && value.last_refresh !== null) {
    if (typeof value.last_refresh !== "string" || Number.isNaN(Date.parse(value.last_refresh))) return false;
  }
  if (value.tokens !== undefined && value.tokens !== null && !validCodexTokens(value.tokens, false))
    return false;
  if (
    value.agent_identity !== undefined &&
    value.agent_identity !== null &&
    !validAgentIdentity(value.agent_identity)
  ) {
    return false;
  }
  if (
    value.bedrock_api_key !== undefined &&
    value.bedrock_api_key !== null &&
    !validBedrockApiKey(value.bedrock_api_key)
  ) {
    return false;
  }
  if (value.auth_mode !== undefined && value.auth_mode !== null && typeof value.auth_mode !== "string") {
    return false;
  }

  const mode =
    typeof value.auth_mode === "string"
      ? value.auth_mode
      : nonEmptyString(value.personal_access_token)
        ? "personalAccessToken"
        : value.bedrock_api_key
          ? "bedrockApiKey"
          : nonEmptyString(value.OPENAI_API_KEY)
            ? "apikey"
            : "chatgpt";
  switch (mode) {
    case "apikey":
      return nonEmptyString(value.OPENAI_API_KEY);
    case "chatgpt":
      return validCodexTokens(value.tokens, true) || validRegisteredAgentIdentity(value.agent_identity);
    case "chatgptAuthTokens":
      return (
        validCodexTokens(value.tokens, false) &&
        isRecord(value.tokens) &&
        nonEmptyString(value.tokens.account_id)
      );
    case "agentIdentity":
      return validAgentIdentity(value.agent_identity);
    case "personalAccessToken":
      return nonEmptyString(value.personal_access_token);
    case "bedrockApiKey":
      return validBedrockApiKey(value.bedrock_api_key);
    case "headers":
    default:
      return false;
  }
}

function validCodexTokens(value: unknown, requireRefresh: boolean): boolean {
  if (!isRecord(value)) return false;
  if (
    !validJwt(value.id_token) ||
    !nonEmptyString(value.access_token) ||
    typeof value.refresh_token !== "string" ||
    (requireRefresh && !nonEmptyString(value.refresh_token))
  ) {
    return false;
  }
  return value.account_id === undefined || value.account_id === null || typeof value.account_id === "string";
}

function validAgentIdentity(value: unknown): boolean {
  if (typeof value === "string") return validJwt(value);
  return validRegisteredAgentIdentity(value);
}

function validRegisteredAgentIdentity(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    nonEmptyString(value.agent_runtime_id) &&
    nonEmptyString(value.agent_private_key) &&
    nonEmptyString(value.account_id) &&
    nonEmptyString(value.chatgpt_user_id) &&
    nonEmptyString(value.plan_type) &&
    typeof value.chatgpt_account_is_fedramp === "boolean" &&
    (value.email === undefined || value.email === null || typeof value.email === "string") &&
    (value.task_id === undefined || value.task_id === null || typeof value.task_id === "string")
  );
}

function validBedrockApiKey(value: unknown): boolean {
  return isRecord(value) && nonEmptyString(value.api_key) && nonEmptyString(value.region);
}

function validJwt(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) return false;
  try {
    return isRecord(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
  } catch {
    return false;
  }
}

function optionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function defaultClaudeAuth(environment: NodeJS.ProcessEnv, configDirectory: string): Promise<boolean> {
  void configDirectory;
  const bedrock = enabled(environment.CLAUDE_CODE_USE_BEDROCK);
  const vertex = enabled(environment.CLAUDE_CODE_USE_VERTEX);
  if (bedrock && vertex) return false;
  if (bedrock) {
    return Boolean(
      environment.AWS_ACCESS_KEY_ID?.trim() &&
      environment.AWS_SECRET_ACCESS_KEY?.trim() &&
      (environment.AWS_REGION?.trim() || environment.AWS_DEFAULT_REGION?.trim()),
    );
  }
  if (vertex) {
    const credentials = environment.GOOGLE_APPLICATION_CREDENTIALS?.trim();
    if (
      !credentials ||
      !environment.ANTHROPIC_VERTEX_PROJECT_ID?.trim() ||
      !environment.CLOUD_ML_REGION?.trim()
    ) {
      return false;
    }
    return access(credentials, constants.R_OK).then(
      () => true,
      () => false,
    );
  }
  return Boolean(environment.ANTHROPIC_API_KEY?.trim());
}

function defaultCodexBoundary(input: {
  command: string;
  environment: NodeJS.ProcessEnv;
  toolEnvironment: NodeJS.ProcessEnv;
  deniedReadPaths: string[];
}): Promise<boolean> {
  return (async () => {
    const directory = await mkdtemp(join(tmpdir(), "clankie-codex-boundary-"));
    const sentinel = join(directory, "arbitrary-host-private-sentinel");
    await writeFile(sentinel, "boundary probe only\n", { mode: 0o600 });
    try {
      return await probeCodexToolBoundary(
        {
          command: input.command,
          environment: input.environment,
          toolEnvironment: input.toolEnvironment,
          deniedReadPaths: input.deniedReadPaths,
          turnTimeoutMs: 5_000,
        },
        sentinel,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
}

async function defaultOllamaModels(url: URL): Promise<string[]> {
  const response = await fetch(new URL("/api/tags", url), { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error("Ollama readiness failed");
  const body = (await response.json()) as { models?: Array<{ name?: unknown; model?: unknown }> };
  return (body.models ?? [])
    .flatMap((entry) => [entry.name, entry.model])
    .filter((name): name is string => typeof name === "string");
}

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function requireSetting(
  value: string | undefined,
  code: string,
  issues: ProviderReadinessIssue[],
): string | undefined {
  const setting = value?.trim();
  if (!setting) issues.push({ code, message: "Configure this required provider setting." });
  return setting || undefined;
}

function disabled(provider: ProviderName, workerId: string): ProviderReadinessReport {
  return { provider, workerId, status: "disabled", issues: [] };
}

function ready(provider: ProviderName, workerId: string): ProviderReadinessReport {
  return { provider, workerId, status: "ready", issues: [] };
}

function unavailable(
  provider: ProviderName,
  workerId: string,
  issues: ProviderReadinessIssue[],
): ProviderReadinessReport {
  return { provider, workerId, status: "unavailable", issues };
}
