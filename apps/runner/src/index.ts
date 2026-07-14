import { homedir } from "node:os";
import { join } from "node:path";
import { ClankieApiClient } from "@clankie/api-client";
import { compileDoctrine, loadDoctrineFile, type CompiledDoctrine } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import { loadMcpRegistryFile, type McpRegistry } from "@clankie/mcp-registry";
import { createLogger } from "@clankie/observability";
import { MissionWorker } from "./mission-worker.ts";
import { ProcessLeaseManager } from "./process-leases.ts";
import { createReadyProviderFleet } from "./provider-factory.ts";
import { publishProviderReadinessSignal } from "./provider-readiness-signal.ts";
import { ShellSandbox } from "./sandbox.ts";
import { defaultWorktreeRoot, WorktreeManager } from "./worktrees.ts";
import { buildConfiguredShellAdapter, buildWorkerAdapters, simWorkersEnabled } from "./worker-descriptors.ts";
import { buildWorkerEnvironment } from "./worker-environment.ts";
import { parseVerificationChecks } from "./verification-checks.ts";
import { TerminalManager } from "./terminals.ts";
import { HerdrSocketTransport, HerdrTerminalProvider } from "./herdr-provider.ts";
import { CompositeTerminalSourceProvider, type TerminalSourceProvider } from "./terminal-source.ts";
import {
  installDevHandoffShutdown,
  readDevHandoffConfig,
  startTerminalGatewayDevHandoff,
} from "./terminal-gateway-dev-handoff.ts";

if (process.argv.includes("--recovery-probe")) {
  const { runRecoveryProbeFromCli } = await import("./recovery-probe.ts");
  await runRecoveryProbeFromCli();
}

const logger = createLogger({
  service: "clankie-runner",
  version: "0.1.0",
  runnerId: process.env.CLANKIE_RUNNER_ID ?? "local",
});
logger.info(
  {
    pid: process.pid,
    cwd: process.cwd(),
    node: process.version,
    controlPlane: process.env.CLANKIE_CONTROL_PLANE_URL ?? "http://127.0.0.1:4310",
  },
  "runner skeleton started",
);

const repoPath = process.env.CLANKIE_REPO_PATH;
let worktrees: WorktreeManager | undefined;
if (repoPath) {
  worktrees = new WorktreeManager({
    repoPath,
    rootDir: process.env.CLANKIE_WORKTREE_ROOT ?? defaultWorktreeRoot(repoPath, homedir()),
  });
  try {
    const reclaimed = await worktrees.reclaimOrphans();
    logger.info(
      {
        repoPath,
        removed: reclaimed.removed.length,
        preserved: reclaimed.preserved.length,
        live: reclaimed.live.length,
        failed: reclaimed.failed.length,
        corruptRemoved: reclaimed.corruptRemoved.length,
      },
      "startup worktree reclamation finished",
    );
  } catch (error) {
    logger.error(
      { repoPath, err: error instanceof Error ? error.message : String(error) },
      "startup worktree reclamation failed; runner continuing",
    );
  }
} else {
  logger.info("CLANKIE_REPO_PATH is unset; worktree management is idle");
}

const runnerStateRoot = process.env.CLANKIE_RUNNER_STATE ?? join(homedir(), ".clankie", "runner");
const terminalManager = new TerminalManager();
const runnerEvents = new SqliteEventStore(join(runnerStateRoot, "runner-events.db"));
try {
  const processLeases = new ProcessLeaseManager({
    rootDir: runnerStateRoot,
    events: runnerEvents,
  });
  const reconciled = await processLeases.reconcile();
  logger.info(
    {
      runnerStateRoot,
      readopted: reconciled.readopted.length,
      failed: reconciled.failed.length,
      retained: reconciled.retained.length,
      corruptRemoved: reconciled.corruptRemoved.length,
    },
    "startup process-lease reconciliation finished",
  );
} catch (error) {
  logger.error(
    { runnerStateRoot, err: error instanceof Error ? error.message : String(error) },
    "startup process-lease reconciliation failed; runner continuing",
  );
}

// Observe-only terminal gateway dev handoff is explicit opt-in and fail-closed: a disabled or
// misconfigured gateway never binds and never blocks runner mission execution. Startup logs carry
// only static reason codes and safe counts — never a token, header, identifier, or raw error text.
try {
  const devHandoffConfig = readDevHandoffConfig(process.env);
  if (devHandoffConfig) {
    let terminalSource: TerminalSourceProvider = terminalManager;
    if (process.env.CLANKIE_HERDR_TERMINAL_SOURCE_ENABLED === "1") {
      const socketPath = process.env.HERDR_SOCKET_PATH?.trim();
      if (!socketPath) throw new Error("herdr_terminal_source_socket_missing");
      const herdr = new HerdrTerminalProvider({
        transport: new HerdrSocketTransport({ socketPath }),
      });
      await herdr.refresh();
      terminalSource = new CompositeTerminalSourceProvider([terminalManager, herdr]);
      await terminalSource.refresh();
    }
    const handoff = await startTerminalGatewayDevHandoff({
      manager: terminalSource,
      config: devHandoffConfig,
      logger,
    });
    logger.info(
      { event: "terminal.gateway.enabled", host: handoff.address.host, port: handoff.address.port },
      "observe-only terminal gateway enabled",
    );
    installDevHandoffShutdown(handoff, { logger });
  }
} catch {
  logger.error(
    { event: "terminal.gateway.disabled", reason: "startup_failed" },
    "terminal gateway failed to start; runner mission execution continues",
  );
}

const runnerToken = process.env.CLANKIE_RUNNER_TOKEN;
if (!repoPath) {
  logger.error("CLANKIE_REPO_PATH is required; mission execution is unavailable");
} else if (!runnerToken) {
  logger.error("CLANKIE_RUNNER_TOKEN is required; mission execution is unavailable");
} else if (worktrees) {
  const workerEnvironment = buildWorkerEnvironment(process.env);
  const verificationChecks = parseVerificationChecks(process.env.CLANKIE_VERIFICATION_CHECKS);
  let doctrine: CompiledDoctrine | undefined;
  let mcpRegistry: McpRegistry | undefined;
  const doctrinePath = process.env.CLANKIE_DOCTRINE?.trim();
  const mcpRegistryPath = process.env.CLANKIE_MCP_REGISTRY?.trim();
  if (doctrinePath) {
    try {
      doctrine = compileDoctrine([await loadDoctrineFile(doctrinePath)]);
    } catch (error) {
      logger.error(
        { doctrinePath, err: error instanceof Error ? error.message : String(error) },
        "doctrine profile failed to compile; MCP and web tool projection stays fail-closed",
      );
    }
  }
  if (mcpRegistryPath) {
    if (!doctrine) {
      logger.error(
        { mcpRegistryPath },
        "CLANKIE_MCP_REGISTRY is set without a compiled CLANKIE_DOCTRINE profile; no MCP tool will be projected",
      );
    } else {
      try {
        mcpRegistry = await loadMcpRegistryFile(mcpRegistryPath);
      } catch (error) {
        logger.error(
          { mcpRegistryPath, err: error instanceof Error ? error.message : String(error) },
          "MCP registry failed to load; no MCP tool will be projected",
        );
      }
    }
  }
  const providerSandbox = new ShellSandbox({
    events: runnerEvents,
    decideEscalation: (request) =>
      Promise.resolve(
        request.action === "runner.sandbox.escalate"
          ? {
              effect: "allow" as const,
              reason: "Runner configuration permits the pinned Pi process to reach exact localhost Ollama.",
              matchedPolicyIds: ["runner.pi.local-ollama"],
              obligations: [],
            }
          : {
              effect: "deny" as const,
              reason: "Provider sandbox bypass is not configured.",
              matchedPolicyIds: ["runner.provider.fail-closed"],
              obligations: [],
            },
      ),
  });
  const fleet = simWorkersEnabled(process.env)
    ? { adapters: buildWorkerAdapters(process.env, workerEnvironment), metadata: undefined, reports: [] }
    : await createReadyProviderFleet({
        environment: process.env,
        workerEnvironment,
        runnerStateRoot,
        ...(doctrine ? { doctrine } : {}),
        ...(mcpRegistry ? { mcpRegistry } : {}),
        sandbox: providerSandbox,
      });
  const configuredShell = buildConfiguredShellAdapter(
    process.env,
    workerEnvironment,
    terminalManager,
    providerSandbox,
  );
  if (configuredShell) fleet.adapters.push(configuredShell);
  const readinessPath = process.env.CLANKIE_RUNNER_READINESS_PATH?.trim();
  const readinessNonce = process.env.CLANKIE_RUNNER_READINESS_NONCE?.trim();
  if (Boolean(readinessPath) !== Boolean(readinessNonce)) {
    throw new Error(
      "CLANKIE_RUNNER_READINESS_PATH and CLANKIE_RUNNER_READINESS_NONCE must be configured together",
    );
  }
  if (readinessPath && readinessNonce) {
    const readiness = await publishProviderReadinessSignal({
      path: readinessPath,
      nonce: readinessNonce,
      runnerId: process.env.CLANKIE_RUNNER_ID ?? "local",
      reports: fleet.reports,
    });
    logger.info(
      { readiness: readiness.status, workerIds: readiness.workers.map((worker) => worker.workerId) },
      "provider readiness signal published",
    );
  }
  for (const report of fleet.reports) {
    const fields = {
      provider: report.provider,
      workerId: report.workerId,
      readiness: report.status,
      issueCodes: report.issues.map((issue) => issue.code),
    };
    if (report.status === "unavailable") logger.warn(fields, "provider is not advertised");
    else logger.info(fields, "provider readiness evaluated");
  }
  if ("mcp" in fleet && fleet.mcp) {
    logger.info(
      {
        allowedActions: fleet.mcp.grants.allowed.map((grant) => grant.action),
        withheldActions: fleet.mcp.grants.withheld.map((grant) => ({
          action: grant.action,
          effect: grant.effect,
        })),
        claudeWithheldServers: fleet.mcp.claude.withheldServers,
        codexWithheldServers: fleet.mcp.codex.withheldServers,
      },
      "mcp registry projected through doctrine",
    );
  }
  if ("claudeWebTools" in fleet && fleet.claudeWebTools.length > 0) {
    logger.info({ webTools: fleet.claudeWebTools }, "native web research tools granted to Claude worker");
  }
  if ("browser" in fleet && fleet.browser) {
    logger.info(
      {
        action: fleet.browser.action,
        projection: fleet.browser.status,
        reason: fleet.browser.reason,
        ...(fleet.browser.version ? { version: fleet.browser.version } : {}),
      },
      "agent-browser capability projected through doctrine",
    );
  }
  if (fleet.adapters.length === 0) {
    logger.error("No provider passed readiness; mission execution remains fail-closed");
  } else {
    const abort = new AbortController();
    process.once("SIGINT", () => abort.abort());
    process.once("SIGTERM", () => abort.abort());
    const missionWorker = new MissionWorker({
      client: new ClankieApiClient({
        baseUrl: process.env.CLANKIE_CONTROL_PLANE_URL ?? "http://127.0.0.1:4310",
        runnerToken,
        runnerId: process.env.CLANKIE_RUNNER_ID ?? "local",
      }),
      adapters: fleet.adapters,
      worktrees,
      artifactRoot: process.env.CLANKIE_ARTIFACT_ROOT ?? join(runnerStateRoot, "artifacts"),
      workerEnvironment,
      verificationChecks,
      ...(fleet.metadata ? { providerMetadata: fleet.metadata } : {}),
      waitingUserPolicy: process.env.CLANKIE_NONINTERACTIVE_WAITING_USER === "allow" ? "allow" : "block",
      hasHumanControlLease: (workerRunId) => terminalManager.hasHumanControl(workerRunId),
      terminalManager,
      ...(process.env.CLANKIE_BASE_REF ? { baseRef: process.env.CLANKIE_BASE_REF } : {}),
    });
    logger.info(
      {
        workerIds: fleet.adapters.map((adapter) => adapter.descriptor.id),
        simWorkers: simWorkersEnabled(process.env),
      },
      "runner pull worker started",
    );
    await missionWorker.runForever(abort.signal);
  }
}
