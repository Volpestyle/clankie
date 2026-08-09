import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ClankieApiClient } from "@clankie/api-client";
import {
  acquireBodyLock,
  defaultGbaBodyRootDir,
  defaultGbaCheckpointDir,
  defaultGbaPlayJournalDir,
  openFreePlayJournal,
  RealGbaRouteScenarioSchema,
  writeGbaCheckpoint,
  type FreePlayResult,
  type FreePlayTurn,
  type GbaCheckpointCapability,
} from "@clankie/gba-emulator";
import { createDefaultCredentialStore, resolveRunnerCredential } from "@clankie/credential-broker";
import { compileDoctrine, loadDoctrineFile, type CompiledDoctrine } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import { loadMcpRegistryFile, type McpRegistry } from "@clankie/mcp-registry";
import { createLogger } from "@clankie/observability";
import { MissionWorker, parseMissionWorkerConcurrency } from "./mission-worker.ts";
import { createGbaPlayExecution } from "./play-execution.ts";
import { PlayHost, type PlayExecution } from "./play-host.ts";
import { ProcessLeaseManager } from "./process-leases.ts";
import { createReadyProviderFleet } from "./provider-factory.ts";
import { publishProviderReadinessSignal } from "./provider-readiness-signal.ts";
import { ShellSandbox } from "./sandbox.ts";
import { defaultWorktreeRoot, WorktreeManager } from "./worktrees.ts";
import { buildConfiguredShellAdapter, buildWorkerAdapters, simWorkersEnabled } from "./worker-descriptors.ts";
import { buildWorkerEnvironment } from "./worker-environment.ts";
import { parseVerificationChecks } from "./verification-checks.ts";
import { TerminalManager } from "./terminals.ts";
import {
  canonicalWorkspaceRoot,
  HerdrSocketTransport,
  HerdrTerminalProvider,
} from "./herdr-provider.ts";
import {
  createCompositeHerdrAgentSource,
  discoverHerdrSessionEndpoints,
} from "./herdr-session-discovery.ts";
import { AgentCensusService } from "./agent-census.ts";
import { AGENT_CENSUS_GATEWAY_PORT, createAgentCensusGateway } from "./agent-census-gateway.ts";
import { BROWSER_GATEWAY_PORT, createBrowserGateway } from "./browser-gateway.ts";
import { createBrowserHost } from "./browser-host.ts";
import { WorkerAdoptionStore } from "./worker-adoptions.ts";
import { CompositeTerminalSourceProvider, type TerminalSourceProvider } from "./terminal-source.ts";
import {
  installDevHandoffShutdown,
  readDevHandoffConfig,
  startTerminalGatewayDevHandoff,
} from "./terminal-gateway-dev-handoff.ts";
import { WorkerTranscriptProjection } from "./worker-transcript.ts";
import {
  createWorkerTranscriptGateway,
  WORKER_TRANSCRIPT_GATEWAY_PORT,
} from "./worker-transcript-gateway.ts";
import { ActivityObservationProjection } from "./activity-observation.ts";
import {
  ACTIVITY_OBSERVATION_GATEWAY_PORT,
  createActivityObservationGateway,
} from "./activity-observation-gateway.ts";

export {
  createRunnerEnvironmentLifecycle,
  createRunnerMinecraftEnvironmentLifecycle,
} from "./environment-lifecycle.ts";

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

const runnerAbort = new AbortController();
const playShutdownDeadlineMs = parsePositiveInt(process.env.CLANKIE_PLAY_SHUTDOWN_DEADLINE_MS, 15_000);
let playHostForShutdown: PlayHost | undefined;
let shutdownStarted = false;

function requestRunnerShutdown(signal: "SIGINT" | "SIGTERM"): void {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const exitCode = signal === "SIGINT" ? 130 : 143;
  process.exitCode = exitCode;
  logger.info({ signal, exitCode, playShutdownDeadlineMs }, "runner shutdown requested");
  runnerAbort.abort(signal);
  void (async () => {
    const result = await (playHostForShutdown?.stopAndWait({
      deadlineMs: playShutdownDeadlineMs,
      reason: signal,
    }) ?? Promise.resolve({ status: "idle" as const }));
    if (result.status === "deadline_expired") {
      logger.error(
        { signal, sessionId: result.sessionId, deadlineMs: playShutdownDeadlineMs, exitCode: 1 },
        "runner shutdown forced after asked-play deadline expired",
      );
      process.exit(1);
    }
    logger.info({ signal, exitCode, playShutdown: result.status }, "runner shutdown settled");
  })();
}

process.on("SIGINT", () => requestRunnerShutdown("SIGINT"));
process.on("SIGTERM", () => requestRunnerShutdown("SIGTERM"));

const repoPath = process.env.CLANKIE_REPO_PATH;
const canonicalRepoRoot = repoPath ? await canonicalWorkspaceRoot(repoPath) : undefined;
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
// Env wins when deliberately set; otherwise the broker-owned bearer the
// control plane minted on its first start. Resolve-only — the runner never
// mints, which keeps a single writer for the credential.
const runnerToken = process.env.CLANKIE_RUNNER_TOKEN ?? (await resolveRunnerCredential());
const terminalManager = new TerminalManager();
const transcriptProjection = await WorkerTranscriptProjection.open(
  process.env.CLANKIE_WORKER_TRANSCRIPT_ROOT ?? join(runnerStateRoot, "worker-transcripts"),
  {
    maxEntriesPerRun: Number(process.env.CLANKIE_WORKER_TRANSCRIPT_MAX_ENTRIES ?? 500),
  },
);
const activityObservationProjection = new ActivityObservationProjection();
const runnerEvents = new SqliteEventStore(join(runnerStateRoot, "runner-events.db"));
const processLeases = new ProcessLeaseManager({
  rootDir: runnerStateRoot,
  events: runnerEvents,
});
try {
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

// Adoption (ADR 0078). The census runs after lease reconciliation so this
// runner's own workers are already recognizable, and it never adopts anything:
// an unclaimed agent is reported and left alone.
const workerAdoptions = new WorkerAdoptionStore({ rootDir: runnerStateRoot, events: runnerEvents });
const herdrSessionEndpoints = await discoverHerdrSessionEndpoints(process.env);
const herdrAgentSource = createCompositeHerdrAgentSource(herdrSessionEndpoints);
logger.info(
  { event: "agent_census.herdr_sessions_discovered", count: herdrSessionEndpoints.length },
  "Herdr session discovery finished",
);
const agentCensus = new AgentCensusService({
  runnerId: process.env.CLANKIE_RUNNER_ID ?? "local",
  adoptions: workerAdoptions,
  observe: async () => {
    if (!herdrAgentSource) return undefined;
    try {
      return await herdrAgentSource.listAgents();
    } catch {
      // "I cannot see" is not "nothing is running": returning undefined keeps
      // the census honest and lapses no live adoption.
      logger.warn({ event: "agent_census.transport_unavailable" }, "herdr agent listing failed");
      return undefined;
    }
  },
  leases: () => processLeases.list(),
  ...(herdrAgentSource
    ? {
        deliver: (binding, text) => herdrAgentSource.sendToAgent(binding, text),
      }
    : {}),
});
try {
  await agentCensus.reconcileAtStartup();
} catch (error) {
  logger.error(
    { err: error instanceof Error ? error.message : String(error) },
    "startup agent census failed; runner continuing with an unknown fleet",
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

if (runnerToken) {
  const transcriptGateway = await createWorkerTranscriptGateway({
    projection: transcriptProjection,
    token: runnerToken,
    port: Number(process.env.CLANKIE_WORKER_TRANSCRIPT_PORT ?? WORKER_TRANSCRIPT_GATEWAY_PORT),
  });
  const closeTranscriptGateway = () => void transcriptGateway.close().catch(() => undefined);
  process.once("SIGINT", closeTranscriptGateway);
  process.once("SIGTERM", closeTranscriptGateway);
  logger.info(
    {
      event: "worker_transcript.gateway.enabled",
      host: transcriptGateway.address.host,
      port: transcriptGateway.address.port,
    },
    "runner-owned worker transcript gateway enabled",
  );
}

if (runnerToken) {
  const censusGateway = await createAgentCensusGateway({
    agents: agentCensus,
    token: runnerToken,
    port: Number(process.env.CLANKIE_AGENT_CENSUS_PORT ?? AGENT_CENSUS_GATEWAY_PORT),
  });
  const closeCensusGateway = () => void censusGateway.close().catch(() => undefined);
  process.once("SIGINT", closeCensusGateway);
  process.once("SIGTERM", closeCensusGateway);
  logger.info(
    {
      event: "agent_census.gateway.enabled",
      host: censusGateway.address.host,
      port: censusGateway.address.port,
    },
    "runner-owned agent census gateway enabled",
  );
}

if (runnerToken) {
  const activityGateway = await createActivityObservationGateway({
    projection: activityObservationProjection,
    token: runnerToken,
    port: Number(process.env.CLANKIE_ACTIVITY_OBSERVATION_PORT ?? ACTIVITY_OBSERVATION_GATEWAY_PORT),
  });
  const closeActivityGateway = () => void activityGateway.close().catch(() => undefined);
  process.once("SIGINT", closeActivityGateway);
  process.once("SIGTERM", closeActivityGateway);
  logger.info(
    {
      event: "activity_observation.gateway.enabled",
      host: activityGateway.address.host,
      port: activityGateway.address.port,
    },
    "runner-owned activity observation gateway enabled",
  );
}

// Asked embodiment (ADR 0063): the play host shares this process because it
// shares the trust boundary — the runner owns the body and the producer
// credential — but it needs neither a repo nor a provider fleet, so it starts
// whenever the runner can authenticate at all.
if (runnerToken) {
  const playHost = new PlayHost({
    client: new ClankieApiClient({
      baseUrl: process.env.CLANKIE_CONTROL_PLANE_URL ?? "http://127.0.0.1:4310",
      runnerToken,
      runnerId: process.env.CLANKIE_RUNNER_ID ?? "local",
    }),
    runnerId: process.env.CLANKIE_RUNNER_ID ?? "local",
    environmentIds: ["pokemon-firered"],
    execute: createConfiguredPlayExecution(),
    logger,
  });
  playHostForShutdown = playHost;
  logger.info({ environmentIds: ["pokemon-firered"] }, "embodiment play host started");
  void playHost.runForever(runnerAbort.signal).catch((error: unknown) => {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      "embodiment play host stopped unexpectedly",
    );
  });
} else {
  logger.error("No runner credential (start the control plane once to mint it); asked play is unavailable");
}

if (!repoPath) {
  logger.error("CLANKIE_REPO_PATH is required; mission execution is unavailable");
} else if (!runnerToken) {
  logger.error(
    "No runner credential (start the control plane once to mint it); mission execution is unavailable",
  );
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
  // Clankie's own browser (ADR 0082). Off unless the operator enables it and
  // doctrine plus a registry are both present, so the fail-closed rule that
  // governs every other MCP projection governs this one too.
  if (
    runnerToken &&
    doctrine &&
    mcpRegistry &&
    /^(1|true|yes|on)$/iu.test(process.env.CLANKIE_BROWSER_ENABLED?.trim() ?? "")
  ) {
    try {
      const browserHost = await createBrowserHost({
        registry: mcpRegistry,
        doctrine,
        runnerStateRoot,
        logger,
        environment: process.env,
      });
      const browserGateway = await createBrowserGateway({
        host: browserHost,
        token: runnerToken,
        port: Number(process.env.CLANKIE_BROWSER_PORT ?? BROWSER_GATEWAY_PORT),
      });
      const closeBrowser = () => {
        void browserGateway.close().catch(() => undefined);
        void browserHost.close().catch(() => undefined);
      };
      process.once("SIGINT", closeBrowser);
      process.once("SIGTERM", closeBrowser);
      logger.info(
        {
          event: "browser.gateway.enabled",
          host: browserGateway.address.host,
          port: browserGateway.address.port,
        },
        "runner-owned browser gateway enabled",
      );
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "browser host failed to start; Clankie has no browser this run",
      );
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
        credentialStore: createDefaultCredentialStore(),
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
    const missionWorker = new MissionWorker({
      client: new ClankieApiClient({
        baseUrl: process.env.CLANKIE_CONTROL_PLANE_URL ?? "http://127.0.0.1:4310",
        runnerToken,
        runnerId: process.env.CLANKIE_RUNNER_ID ?? "local",
      }),
      adapters: fleet.adapters,
      reservations: async () => {
        if (herdrAgentSource) {
          try {
            await workerAdoptions.reconcile(await herdrAgentSource.listAgents());
          } catch {
            // Preserve active reservations when the transport cannot be asked:
            // uncertainty must not silently admit a second writer.
          }
        }
        return (await workerAdoptions.active())
          .filter(
            (adoption) =>
              adoption.grade === "directed" &&
              adoption.binding.workspace.root === canonicalRepoRoot,
          )
          .map((adoption) => ({
            id: adoption.adoptionId,
            workspaceRoot: adoption.binding.workspace.root,
            writeScope: [...adoption.reservedWriteScope],
          }));
      },
      worktrees,
      artifactRoot: process.env.CLANKIE_ARTIFACT_ROOT ?? join(runnerStateRoot, "artifacts"),
      workerEnvironment,
      verificationChecks,
      ...(fleet.metadata ? { providerMetadata: fleet.metadata } : {}),
      waitingUserPolicy: process.env.CLANKIE_NONINTERACTIVE_WAITING_USER === "allow" ? "allow" : "block",
      hasHumanControlLease: (workerRunId) => terminalManager.hasHumanControl(workerRunId),
      terminalManager,
      transcriptProjection,
      maxConcurrency: parseMissionWorkerConcurrency(process.env.CLANKIE_RUNNER_MAX_CONCURRENCY),
      ...(process.env.CLANKIE_BASE_REF ? { baseRef: process.env.CLANKIE_BASE_REF } : {}),
    });
    logger.info(
      {
        workerIds: fleet.adapters.map((adapter) => adapter.descriptor.id),
        simWorkers: simWorkersEnabled(process.env),
        maxConcurrency: parseMissionWorkerConcurrency(process.env.CLANKIE_RUNNER_MAX_CONCURRENCY),
      },
      "runner pull worker started",
    );
    await missionWorker.runForever(runnerAbort.signal);
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createConfiguredPlayExecution(): PlayExecution {
  const fixture = process.env.CLANKIE_RUNNER_TEST_PLAY_EXECUTION;
  if (fixture === "shutdown-fixture" || fixture === "ignore-stop") {
    return createShutdownFixturePlayExecution({ ignoreStop: fixture === "ignore-stop" });
  }
  return createGbaPlayExecution({ logger, activityObservations: activityObservationProjection });
}

function createShutdownFixturePlayExecution(input: { ignoreStop: boolean }): PlayExecution {
  return async (session, control, onRunning) => {
    const bodyLock = acquireBodyLock({
      rootDir: defaultGbaBodyRootDir(process.env),
      holderId: `captain-play:${session.sessionId}`,
    });
    const startedAt = Date.now();
    try {
      const journal = openFreePlayJournal({
        rootDir: defaultGbaPlayJournalDir(process.env),
        runId: session.sessionId,
        environmentSessionId: `test-play:${session.sessionId}`,
        scenarioId: "shutdown-fixture",
      });
      await onRunning();
      const turns: FreePlayTurn[] = [];
      for (let turn = 0; input.ignoreStop || !control.stopRequested() || turns.length === 0; turn += 1) {
        await sleep(25);
        const record = shutdownFixtureTurn(turn);
        turns.push(record);
        journal.turn(record);
      }
      const result = shutdownFixtureResult(turns);
      const checkpoint = writeGbaCheckpoint({
        rootDir: defaultGbaCheckpointDir(process.env),
        capability: shutdownFixtureCheckpointCapability(session.sessionId),
        label: "asked-play",
        position: null,
        continuity:
          turns.at(-1) === undefined
            ? null
            : { notes: turns.at(-1)?.notes ?? null, objective: turns.at(-1)?.objective ?? null },
      });
      const durationMs = Date.now() - startedAt;
      journal.summary({
        outcome: "stopped",
        result,
        durationMs,
        framesPublished: turns.length,
        framesDropped: 0,
        checkpointId: checkpoint.receipt.checkpointId,
      });
      return {
        kind: "ran",
        result: {
          outcome: "stopped",
          turnsTaken: turns.length,
          durationMs,
          framesPublished: turns.length,
          framesDropped: 0,
          checkpointId: checkpoint.receipt.checkpointId,
        },
      };
    } finally {
      bodyLock.release();
    }
  };
}

function shutdownFixtureTurn(turn: number): FreePlayTurn {
  return {
    turn,
    observationSha256: "a".repeat(64),
    framebufferSha256: null,
    monologue: "settling shutdown at a turn boundary",
    intent: "press a",
    action: { kind: "button_press", button: "a", holdFrames: 2 },
    outcome: "accepted",
    detail: null,
    effect: "advanced one fixture turn",
    notes: "remember the shutdown boundary",
    objective: "settle cleanly",
    interjection: null,
    reply: null,
    speak: null,
    speakSuppressed: false,
    speakWanted: false,
  };
}

function shutdownFixtureResult(turns: readonly FreePlayTurn[]): FreePlayResult {
  return {
    turns: [...turns],
    accepted: turns.length,
    progress: {
      distinctTiles: turns.length,
      maps: ["shutdown-fixture"],
      turnsSinceNewTile: 0,
      actionsPerNewTile: turns.length === 0 ? null : 1,
    },
    volition: { offered: turns.length, taken: 0, suppressed: 0, skipped: 0 },
    coherence: 1,
  };
}

function shutdownFixtureCheckpointCapability(sessionId: string): GbaCheckpointCapability {
  const require = createRequire(import.meta.url);
  const emulatorPackage = dirname(require.resolve("@clankie/gba-emulator/package.json"));
  const scenario = RealGbaRouteScenarioSchema.parse(
    JSON.parse(
      readFileSync(join(emulatorPackage, "fixtures", "firered-bedroom-route", "v1", "scenario.json"), "utf8"),
    ),
  );
  return {
    saveState: () => new TextEncoder().encode(`shutdown-fixture:${sessionId}:${Date.now().toString()}`),
    loadState: () => undefined,
    bootSavestate: () => new TextEncoder().encode("shutdown-fixture-boot"),
    identity: {
      romSha256: scenario.romSha256,
      savestateSha256: scenario.savestateSha256,
      coreWasmSha256: scenario.coreWasmSha256,
    },
    scenario,
  };
}
