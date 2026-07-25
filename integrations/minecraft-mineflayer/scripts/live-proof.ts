import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EnvironmentRuntime, type EnvironmentEventSink } from "@clankie/environment-runtime";
import type { MinecraftStartActionCommand } from "@clankie/interactive-environment";
import {
  ScenarioBindingSchema,
  ScenarioReportSchema,
  verifierGoalEvent,
} from "@clankie/minecraft-paper-verifier";
import {
  MineflayerMinecraftAdapter,
  RealMineflayerMotorFactory,
  inspectMinecraftLiveReadiness,
  minecraftScenarioSessionSpec,
  parseFrozenMinecraftScenario,
  runFrozenCollectCraftPlace,
} from "../src/index.ts";

class MilestoneOutput {
  private readonly lines: string[] = [];
  private readonly waiters = new Set<{
    pattern: RegExp;
    resolve: (line: string) => void;
  }>();
  private stdoutRemainder = "";
  private stderrRemainder = "";

  public attach(process: ChildProcessWithoutNullStreams): void {
    process.stdout.on("data", (chunk: Buffer) => {
      this.stdoutRemainder = this.consume(`${this.stdoutRemainder}${chunk.toString("utf8")}`);
    });
    process.stderr.on("data", (chunk: Buffer) => {
      this.stderrRemainder = this.consume(`${this.stderrRemainder}${chunk.toString("utf8")}`);
    });
  }

  public waitFor(pattern: RegExp, timeoutMs: number, label: string): Promise<string> {
    const existing = this.lines.find((line) => pattern.test(line));
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<string>((resolveLine, rejectLine) => {
      const waiter = { pattern, resolve: resolveLine };
      this.waiters.add(waiter);
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        rejectLine(new Error(`Timed out waiting for ${label}`));
      }, timeoutMs);
      waiter.resolve = (line) => {
        clearTimeout(timer);
        resolveLine(line);
      };
    });
  }

  private consume(value: string): string {
    const lines = value.split(/\r?\n/u);
    const remainder = lines.pop() ?? "";
    for (const line of lines) this.push(line);
    return remainder.slice(-8_192);
  }

  private push(line: string): void {
    const boundedLine = line.slice(0, 8_192);
    this.lines.push(boundedLine);
    if (this.lines.length > 512) this.lines.shift();
    for (const waiter of [...this.waiters]) {
      waiter.pattern.lastIndex = 0;
      if (!waiter.pattern.test(boundedLine)) continue;
      this.waiters.delete(waiter);
      waiter.resolve(boundedLine);
    }
  }
}

const readiness = inspectMinecraftLiveReadiness();
if (readiness.status !== "ready" || !readiness.javaExecutable || !readiness.paperJarPath) {
  const { javaExecutable: _java, paperJarPath: _paper, ...safe } = readiness;
  process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
  process.exit(2);
}
const receiptDirInput = process.env["CLANKIE_MINECRAFT_RECEIPT_DIR"]?.trim();
if (!receiptDirInput) {
  throw new Error("Set CLANKIE_MINECRAFT_RECEIPT_DIR to an operator-owned evidence directory");
}

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const verifierRoot = join(repositoryRoot, "integrations", "minecraft-paper-verifier");
const fixtureRoot = join(repositoryRoot, "scenarios", "minecraft", "collect-craft-place", "v1");
const receiptDir = resolve(receiptDirInput);
const labRoot = await mkdtemp(join(tmpdir(), "clankie-minecraft-live-"));
const runId = `clankie-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
let server: ChildProcessWithoutNullStreams | undefined;
let runtime: EnvironmentRuntime | undefined;
let activeToken: string | undefined;
let activeSessionId: string | undefined;

try {
  const javaHome = dirname(dirname(readiness.javaExecutable));
  const build = spawnSync(join(verifierRoot, "gradlew"), ["-p", verifierRoot, "build"], {
    cwd: repositoryRoot,
    env: { ...process.env, JAVA_HOME: javaHome },
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error("Paper verifier build failed");

  await mkdir(join(labRoot, "plugins"), { recursive: true });
  await copyFile(readiness.paperJarPath, join(labRoot, "paper.jar"));
  await copyFile(
    join(verifierRoot, "build", "libs", "clankie-paper-verifier-0.1.0.jar"),
    join(labRoot, "plugins", "clankie-paper-verifier-0.1.0.jar"),
  );
  await copyFile(join(fixtureRoot, "server.properties"), join(labRoot, "server.properties"));
  await writeFile(join(labRoot, "eula.txt"), "eula=true\n", { mode: 0o600 });

  const output = new MilestoneOutput();
  server = spawn(readiness.javaExecutable, ["-Xms1G", "-Xmx1G", "-jar", "paper.jar", "--nogui"], {
    cwd: labRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, JAVA_HOME: javaHome },
  });
  output.attach(server);
  await output.waitFor(/Done \([^)]+\)!/u, 180_000, "Paper server readiness");
  server.stdin.write("whitelist add Clankie\n");
  await output.waitFor(/(?:Added|already).*Clankie|Clankie.*(?:whitelist|listed)/iu, 15_000, "whitelist");

  const fixtureBytes = await readFile(join(fixtureRoot, "scenario.yml"));
  const { scenario, fixtureSha256 } = parseFrozenMinecraftScenario(fixtureBytes);
  const binding = ScenarioBindingSchema.parse(
    JSON.parse(await readFile(join(fixtureRoot, "binding.json"), "utf8")),
  );
  if (binding.fixtureSha256 !== fixtureSha256) {
    throw new Error("Minecraft scenario binding does not match the frozen fixture bytes");
  }

  const adapter = new MineflayerMinecraftAdapter(new RealMineflayerMotorFactory());
  const semanticEvents: Parameters<EnvironmentEventSink["append"]>[0][] = [];
  runtime = new EnvironmentRuntime({
    rootDir: join(labRoot, "runner-state"),
    adapter,
    events: { append: (event) => (semanticEvents.push(event), Promise.resolve()) },
  });
  const connection = {
    serverId: "paper-loopback-lab",
    host: "127.0.0.1",
    port: "25574",
    minecraftVersion: "1.21.11",
    username: scenario["player-name"],
    authMode: "offline_lab",
  } as const;

  const reconnectSpec = minecraftScenarioSessionSpec(
    scenario,
    connection.serverId,
    `minecraft-reconnect-${runId}`,
  );
  const reconnect = await runtime.start({
    spec: reconnectSpec,
    holderId: "runner",
    correlationId: `${runId}:reconnect`,
    connection,
    leaseDurationMs: 300_000,
  });
  await runtime.stop(reconnect.token, reconnectSpec.sessionId, "planned reconnect proof");

  const scenarioSpec = minecraftScenarioSessionSpec(
    scenario,
    connection.serverId,
    `minecraft-gameplay-${runId}`,
  );
  const gameplay = await runtime.start({
    spec: scenarioSpec,
    holderId: "runner",
    correlationId: `${runId}:gameplay`,
    connection,
    leaseDurationMs: 300_000,
  });
  activeToken = gameplay.token;
  activeSessionId = scenarioSpec.sessionId;
  server.stdin.write(`mcscenario start ${runId}\n`);
  await output.waitFor(new RegExp(`Scenario started: ${escapeRegExp(runId)}`, "u"), 15_000, "scenario start");

  const gameplayReceipt = await runFrozenCollectCraftPlace({
    runtime,
    adapter,
    token: gameplay.token,
    scenario,
    fixtureSha256,
    sessionId: scenarioSpec.sessionId,
  });
  server.stdin.write(`mcscenario end ${runId}\n`);
  await output.waitFor(
    new RegExp(`Scenario ended; report=.*${escapeRegExp(runId)}`, "u"),
    15_000,
    "scenario end",
  );

  const verifierRunDir = join(labRoot, "plugins", "ClankiePaperVerifier", "runs", runId);
  const reportPath = join(verifierRunDir, "report.json");
  const eventsPath = join(verifierRunDir, "events.jsonl");
  const reportBytes = await readFile(reportPath);
  const eventsBytes = await readFile(eventsPath);
  verifySidecar(
    reportBytes,
    await readFile(join(verifierRunDir, "report.json.sha256"), "utf8"),
    "report.json",
  );
  verifySidecar(
    eventsBytes,
    await readFile(join(verifierRunDir, "events.jsonl.sha256"), "utf8"),
    "events.jsonl",
  );
  const report = ScenarioReportSchema.parse(JSON.parse(reportBytes.toString("utf8")));
  const goalEvent = verifierGoalEvent(report, binding);
  if (report.result !== "passed" || goalEvent.type !== "minecraft.goal.verified") {
    throw new Error("Authoritative Paper verifier did not pass the frozen objective");
  }
  await runtime.stop(gameplay.token, scenarioSpec.sessionId, "scenario complete");
  activeToken = undefined;
  activeSessionId = undefined;

  const emergencySpec = minecraftScenarioSessionSpec(
    scenario,
    connection.serverId,
    `minecraft-emergency-${runId}`,
  );
  const emergency = await runtime.start({
    spec: emergencySpec,
    holderId: "runner",
    correlationId: `${runId}:emergency`,
    connection,
    leaseDurationMs: 300_000,
  });
  activeToken = emergency.token;
  activeSessionId = emergencySpec.sessionId;
  const waitCommand: MinecraftStartActionCommand = {
    schemaVersion: 1,
    commandId: `${runId}-emergency-command`,
    type: "start_action",
    requestedAt: new Date().toISOString(),
    context: {
      sourceLane: "gameplay",
      authority: {
        principal: { kind: "captain", id: scenario["player-name"].toLowerCase() },
        tier: "autonomous",
      },
      correlationId: `${runId}:emergency-action`,
      expectedGoalVersion: 1,
    },
    sessionId: emergencySpec.sessionId,
    actionId: `${runId}-emergency-action`,
    action: {
      kind: "minecraft_action",
      action: { kind: "wait", durationMs: 60_000 },
      limits: {
        radius: 1,
        timeoutMs: 120_000,
        blockChangeQuota: 0,
        combatPolicy: "none",
      },
    },
  };
  const running = await runtime.startAction(emergency.token, waitCommand);
  if (running.status !== "running") throw new Error("Emergency proof action did not enter running state");
  const emergencyStopped = await runtime.emergencyStop(emergencySpec.sessionId, "live proof");
  activeToken = undefined;
  activeSessionId = undefined;
  if (emergencyStopped.phase !== "off") throw new Error("Emergency stop did not fence the Minecraft body");

  await mkdir(receiptDir, { recursive: true, mode: 0o700 });
  await copyFile(reportPath, join(receiptDir, "paper-report.json"), fsConstants.COPYFILE_EXCL);
  await copyFile(eventsPath, join(receiptDir, "paper-events.jsonl"), fsConstants.COPYFILE_EXCL);
  const semanticProjection = semanticEvents
    .filter(
      (event): event is Extract<(typeof semanticEvents)[number], { plane: "semantic" }> => "type" in event,
    )
    .map((event) => ({
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt,
      correlationId: event.correlationId,
      sessionId: event.sessionId,
    }));
  const receipt = {
    schemaVersion: 1,
    runId,
    result: "passed",
    scenario: {
      scenarioId: report.scenarioId,
      scenarioVersion: report.scenarioVersion,
      fixtureSha256,
    },
    identities: {
      paperJarSha256: readiness.identities.paperJarSha256,
      verifierPluginSha256: sha256(
        await readFile(join(verifierRoot, "build", "libs", "clankie-paper-verifier-0.1.0.jar")),
      ),
    },
    reconnect: {
      firstSessionStopped: true,
      freshSessionStarted: true,
    },
    gameplay: gameplayReceipt,
    authoritativeVerifier: {
      result: report.result,
      checks: report.checks,
      eventType: goalEvent.type,
      eventChainHeadSha256: report.eventChainHeadSha256,
      reportSha256: sha256(reportBytes),
      eventsSha256: sha256(eventsBytes),
    },
    emergencyStop: {
      actionEnteredRunning: true,
      finalPhase: emergencyStopped.phase,
    },
    semanticEvents: semanticProjection,
    boundaries: {
      serverHost: "loopback",
      publicServerCapability: false,
      verifierLifecycleExposedToGameplay: false,
      rawServerOutputRetained: false,
    },
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  await writeFile(join(receiptDir, "minecraft-live-receipt.json"), receiptBytes, {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        result: "passed",
        runId,
        receiptSha256: sha256(receiptBytes),
        authoritativeReportSha256: receipt.authoritativeVerifier.reportSha256,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (runtime && activeToken && activeSessionId) {
    await runtime.stop(activeToken, activeSessionId, "live proof cleanup").catch(() => undefined);
  } else if (runtime && activeSessionId) {
    await runtime.emergencyStop(activeSessionId, "live proof cleanup").catch(() => undefined);
  }
  if (server && server.exitCode === null) {
    server.stdin.write("stop\n");
    await Promise.race([
      new Promise<void>((resolveExit) => server?.once("exit", () => resolveExit())),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 15_000)),
    ]);
    if (server.exitCode === null) server.kill("SIGTERM");
  }
  await rm(labRoot, { recursive: true, force: true });
}

function verifySidecar(bytes: Uint8Array, sidecar: string, filename: string): void {
  const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9._-]+)\s*$/u.exec(sidecar);
  if (!match || match[2] !== filename || match[1] !== sha256(bytes)) {
    throw new Error(`Paper verifier ${filename} hash sidecar is invalid`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
