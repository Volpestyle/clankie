import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import {
  RUNTIME_HEALTH_PATH,
  RuntimeHealthObservationSchema,
  RuntimeHealthSnapshotSchema,
  type RuntimeHealthObservation,
} from "@clankie/protocol";
import { hostedOperatorAllows } from "@clankie/protocol/hosted-operator";
import { parseBodyTelemetryLine } from "@clankie/observability/body-telemetry";
import { SettingsStore } from "@clankie/settings";
import { FileCredentialStore } from "@clankie/credential-broker";
import { createClankieApp, createBearerAuthenticator } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { runRuntimeHealthCommand, formatRuntimeHealth } from "../../tui/src/command/runtime-health.ts";
import { probeHealth } from "../../tui/src/command/gateway.ts";
import { statusCommand } from "../../tui/src/command/status.ts";
import { doctorCommand } from "../../tui/src/command/doctor.ts";
import { formatDoctorReport } from "../../tui/src/doctor-report.ts";
import { buildConsoleCommands } from "../../tui/src/commands.ts";
import type { ClankieFaceShell } from "../../tui/src/shell/shell.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("real busy process and slow HTTP sustain one alarm, recover once with duration, and spool content-free metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-health-loop-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let hotUntil = Infinity;
  const server = createServer((_request, response) => {
    setTimeout(
      () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
      },
      Date.now() < hotUntil ? 200 : 0,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  const script = join(root, "loop.mjs");
  const observer = new URL("../src/runtime-health.ts", import.meta.url).href;
  const telemetry = new URL("../../../packages/observability/src/body-telemetry.ts", import.meta.url).href;
  await writeFile(
    script,
    `
    import { performance } from 'node:perf_hooks';
    import { RuntimeHealthObserver } from ${JSON.stringify(observer)};
    import { createBodyTelemetry } from ${JSON.stringify(telemetry)};
    const spool = createBodyTelemetry({dir:process.argv[3],writer:'runtime-test'});
    const stopHot = Date.now()+1800;
    const output = (value) => process.stdout.write(JSON.stringify(value)+'\\n');
    let notices=0;
    // Fail against the live snapshot if the required recovery never arrives.
    const deadline=setTimeout(()=>{monitor.stop();output({final:monitor.snapshot()});},6000);
    const monitor = new RuntimeHealthObserver({
      settings:async()=>({enabled:true,cpuPercent:30,healthLatencyMs:100,sustainedMs:400,sampleIntervalMs:100,cooldownMs:60000}),
      healthUrl:process.argv[2],
      notify:async(text)=>{notices++;output({notice:text});return true},
      // Capture the recovery transition, before a later independent sample can start another incident.
      observed:(observation)=>{output({observation});spool.emit({event:'body.runtime_health',state:observation.state,cpuPercent:observation.cpuPercent,healthLatencyMs:observation.healthLatencyMs,durationMs:observation.durationMs,reasons:observation.reasons});if(notices===2&&observation.state==='healthy'&&observation.lastRecoveryAt){monitor.stop();clearTimeout(deadline);output({final:monitor.snapshot()})}},
    });
    function busy(){if(Date.now()>=stopHot)return;const until=performance.now()+25;let total=0;while(performance.now()<until){for(let i=0;i<10000;i++)total+=Math.sqrt(i)};if(!Number.isFinite(total))throw Error('loop');setImmediate(busy)}
    monitor.start();busy();output({started:true});
  `,
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", script, `http://127.0.0.1:${address.port}/health`, root],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit").catch(() => undefined);
    }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
    if (hotUntil === Infinity && stdout.includes('"started":true')) hotUntil = Date.now() + 1800;
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const [code] = await once(child, "exit");
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const rows = stdout
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          notice?: string;
          observation?: RuntimeHealthObservation;
          final?: RuntimeHealthObservation;
        },
    );
  const notices = rows.flatMap((row) => (row.notice ? [row.notice] : []));
  expect(notices).toHaveLength(2);
  expect(notices[0]).toContain("Runtime health alarm: cpu and health");
  expect(notices[1]).toMatch(/Runtime health recovered after \d+ms/u);
  const final = rows.find((row) => row.final)?.final;
  const observations = rows.flatMap((row) => (row.observation ? [row.observation] : []));
  const recoveryIndex = observations.findIndex(
    (observation) => observation.state === "healthy" && observation.lastRecoveryAt !== undefined,
  );
  expect(recoveryIndex).toBeGreaterThan(
    observations.findIndex((observation) => observation.state === "alarm"),
  );
  expect(final, JSON.stringify(observations)).toEqual(observations[recoveryIndex]);
  expect(final?.state).toBe("healthy");
  expect(final?.reasons).toEqual([]);
  expect(final?.healthAvailable).toBe(true);
  expect(final?.delivery).toBe("accepted");
  expect(final?.cpuPercent).toBeLessThanOrEqual(30);
  expect(final?.healthLatencyMs).toBeLessThanOrEqual(100);
  expect(final?.lastIncidentDurationMs).toBeGreaterThanOrEqual(400);
  expect(notices[1]).toContain(`after ${final?.lastIncidentDurationMs}ms`);
  expect(final?.lastRecoveryAt).toBeDefined();
  expect(
    rows.some(
      (row) =>
        row.observation?.state === "alarm" &&
        row.observation.cpuPercent! > 30 &&
        row.observation.healthLatencyMs! >= 180,
    ),
  ).toBe(true);
  const events = (
    await Promise.all(
      (
        await readdir(root)
      )
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => readFile(join(root, name), "utf8")),
    )
  )
    .flatMap((contents) => contents.trim().split("\n"))
    .map(parseBodyTelemetryLine);
  expect(events.length).toBeGreaterThan(3);
  for (const event of events) {
    expect(event?.event).toBe("body.runtime_health");
    expect(Object.keys(event!).sort()).toEqual([
      "atMs",
      "cpuPercent",
      "durationMs",
      "event",
      "healthLatencyMs",
      "reasons",
      "state",
      "v",
    ]);
  }
  expect(JSON.stringify(events)).not.toContain("next Linear");
  const valid = events[0]!;
  expect(
    parseBodyTelemetryLine(JSON.stringify({ ...valid, conversation: "PRIVATE_CONVERSATION_SENTINEL" })),
  ).toBeUndefined();
  expect(
    RuntimeHealthObservationSchema.safeParse({ ...final, reportBody: "PRIVATE_REPORT_SENTINEL" }).success,
  ).toBe(false);
}, 15_000);

it("owner API, real CLI and TUI settings share revision guards and public health metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-health-api-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const settings = new SettingsStore(join(root, "settings.json"));
  const observation: RuntimeHealthObservation = {
    state: "alarm",
    cpuPercent: 99,
    healthLatencyMs: 1234,
    healthAvailable: true,
    observedAt: new Date().toISOString(),
    durationMs: 300000,
    reasons: ["cpu", "health"],
    delivery: "accepted",
  };
  const body = await createClankieApp({
    captain: createStubCaptain(),
    settings,
    authenticateOperator: createBearerAuthenticator("runtime-test", { operatorId: "owner" }),
    publicGatewayDoorway: () => ({ state: "disabled" }),
    runtimeHealth: () => observation,
  });
  cleanup.push(async () => {
    await body.close();
  });
  const server = serve({ fetch: body.app.fetch, port: 0, hostname: "127.0.0.1" });
  if (!server.listening) await once(server, "listening");
  cleanup.push(async () => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  const host = `http://127.0.0.1:${address.port}`;
  const options = { host, env: { CLANKIE_OPERATOR_TOKEN: "runtime-test" } };
  expect((await fetch(`${host}${RUNTIME_HEALTH_PATH}`)).status).toBe(401);
  const initial = await runRuntimeHealthCommand([], options);
  expect(initial.settings).toEqual({
    enabled: true,
    cpuPercent: 50,
    healthLatencyMs: 1000,
    sustainedMs: 300000,
    sampleIntervalMs: 15000,
    cooldownMs: 1800000,
  });
  const updated = await runRuntimeHealthCommand(
    ["set", "--cpu-percent", "65", "--health-ms", "1500", "--sustained-seconds", "120"],
    options,
  );
  expect(updated.settings.cpuPercent).toBe(65);
  expect(updated.settings.sustainedMs).toBe(120000);
  expect(updated.observation).toEqual(observation);
  expect((await settings.load()).runtimeHealth).toEqual(updated.settings);
  const post = (value: unknown) =>
    fetch(`${host}${RUNTIME_HEALTH_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer runtime-test", "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  expect(
    (await post({ schemaVersion: 1, expectedRevision: initial.revision, changes: { enabled: false } }))
      .status,
  ).toBe(409);
  expect(
    (await post({ schemaVersion: 1, expectedRevision: updated.revision, changes: { cpuPercent: 0 } })).status,
  ).toBe(400);
  expect(
    (
      await post({
        schemaVersion: 1,
        expectedRevision: updated.revision,
        changes: { conversation: "PRIVATE" },
      })
    ).status,
  ).toBe(400);
  const choices = ["cpuPercent", "toggle", undefined];
  const menus: { message: string; options: { value: string; hint?: string }[] }[] = [];
  const shell = {
    setupFlow: {
      begin() {},
      end() {},
      renderLine() {},
      async readSelect(menu: (typeof menus)[number]) {
        menus.push(menu);
        return choices.shift();
      },
      async readText() {
        return "70";
      },
    },
    insertCommandResult() {},
  } as unknown as ClankieFaceShell;
  const commands = buildConsoleCommands({
    commandRuntimeHealth: (args) => runRuntimeHealthCommand(args, options),
  });
  await commands.find((command) => command.name === "runtime-health")!.run("", shell);
  expect((await settings.load()).runtimeHealth.cpuPercent).toBe(70);
  expect((await settings.load()).runtimeHealth.enabled).toBe(false);
  expect(menus[0]?.options.find((option) => option.value === "cpuPercent")?.hint).toBe("65");
  expect(menus[1]?.options.find((option) => option.value === "cpuPercent")?.hint).toBe("70");
  expect((await probeHealth({ host })).runtimeHealth).toEqual(observation);
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const env = {
    PATH: process.env.PATH ?? "",
    CLANKIE_SETTINGS_FILE: settings.path,
    CLANKIE_OPERATOR_TOKEN: "runtime-test",
    CLANKIE_CAPTAIN_TOKEN: "runtime-captain-test",
    CLANKIE_CONTROL_PLANE_URL: host,
    CLANKIE_CAPTAIN_URL: host,
    PORT: String(address.port),
  };
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const status = await statusCommand({
    repoRoot,
    host,
    env,
    operatorCredentialStore: credentials,
    captainCredentialStore: credentials,
  });
  expect(status.runtimeHealth).toEqual(observation);
  const doctor = await doctorCommand({ repoRoot, host, env, settings, credentialStore: credentials });
  expect(doctor.runtimeHealth).toEqual(observation);
  expect(formatDoctorReport(doctor)).toContain("Runtime health: alarm · CPU 99% · /health 1234ms");
  const publicHealth = (await (await fetch(`${host}/health`)).json()) as { runtimeHealth: unknown };
  expect(RuntimeHealthObservationSchema.parse(publicHealth.runtimeHealth)).toEqual(observation);
  expect(formatRuntimeHealth(observation)).toContain("CPU 99%");
  expect(RuntimeHealthSnapshotSchema.safeParse(updated).success).toBe(true);
  expect(hostedOperatorAllows("GET", RUNTIME_HEALTH_PATH)).toBe(true);
  expect(hostedOperatorAllows("POST", RUNTIME_HEALTH_PATH)).toBe(true);
  expect(hostedOperatorAllows("GET", `${RUNTIME_HEALTH_PATH}?conversation=PRIVATE`)).toBe(false);
}, 30_000);
