import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import {
  automaticSimulatorSlots,
  createResourceGovernor,
  defaultResourcePolicy,
  processIdentity,
} from "@clankie/fleet-resources";
import { FLEET_RESOURCES_PATH, FleetResourcePolicySchema } from "@clankie/protocol";
import { createFleetResourceRuntime } from "../../clankie/src/fleet-resource-runtime.ts";
import { createFleetResourceRoutes } from "../../clankie/src/fleet-resource-routes.ts";
import { createFleetSettingsRoutes } from "../../clankie/src/fleet-settings-routes.ts";
import { runFleetCommand } from "../src/command/fleet.ts";
import { runResourceStatusCommand, runSimulatorCommand } from "../src/command/fleet-resources.ts";
import { doctorCommand } from "../src/command/doctor.ts";
import { formatDoctorReport } from "../src/doctor-report.ts";
import { ResourceStore } from "../../../packages/fleet-resources/src/store.ts";
import { longHeldJobMs } from "../../../packages/fleet-resources/src/parallelism.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const calmPressure = async () => ({ loadRatio: 0, availableMemoryMb: 1_000_000 });
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
/**
 * Polls until the condition holds. A cold CLI under machine load may take
 * longer than any fixed budget, so the only early stop is the owned process
 * exiting first; the test's own timeout remains the backstop (VUH-1981).
 */
async function eventually<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  owner?: { done: Promise<number>; output: string[] },
): Promise<T> {
  let exited: number | undefined;
  void owner?.done.then(
    (code) => (exited = code),
    () => (exited = -1),
  );
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (exited !== undefined)
      throw new Error(`Owned CLI exited ${exited} before it was ready: ${owner!.output.join("")}`);
    await delay(40);
  }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "clankie-resources-cli-"));
  const settings = new SettingsStore(join(directory, "settings.json"));
  const credentials = new FileCredentialStore(join(directory, "credentials.json"));
  const token = mintOperatorToken();
  await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
  // CLI and doctor boundaries, not machine pressure: a busy host must not queue them (VUH-1981).
  let governor = createResourceGovernor({ directory: join(directory, "registry"), probe: calmPressure });
  let resources = await createFleetResourceRuntime({
    governor,
    holderNoticeDirectory: join(directory, "holder-notices"),
    policy: async () => (await settings.load()).fleet.resources,
  });
  const authorize = async (request: Request) =>
    request.headers.get("authorization") === `Bearer ${token}`
      ? (true as const)
      : ("authentication_required" as const);
  let resourceRoutes = createFleetResourceRoutes(authorize, resources);
  const settingsRoutes = createFleetSettingsRoutes(authorize, settings, {
    configureResources: (policy) => resources.configure(policy),
  });
  let mode: "normal" | "legacy" | "invalid" | "unavailable" | "stalled" = "normal";
  const calls: { path: string; method: string }[] = [];
  const server = createServer(async (incoming, outgoing) => {
    const path = new URL(incoming.url!, "http://127.0.0.1").pathname;
    calls.push({ path, method: incoming.method! });
    if (path === FLEET_RESOURCES_PATH && mode === "stalled") return;
    if (path === FLEET_RESOURCES_PATH && mode === "invalid") {
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(JSON.stringify({ error: "Bearer-response-secret-must-not-display" }));
      return;
    }
    const bytes: Buffer[] = [];
    for await (const piece of incoming) bytes.push(Buffer.from(piece));
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers))
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
    const url = `http://127.0.0.1${incoming.url}`;
    const init: RequestInit = {
      method: incoming.method!,
      headers,
      ...(bytes.length ? { body: Buffer.concat(bytes) } : {}),
    };
    let response: Response;
    if (path === FLEET_RESOURCES_PATH && mode === "legacy")
      response = new Response("missing", { status: 404 });
    else if (path === FLEET_RESOURCES_PATH && mode === "unavailable")
      response = await createFleetResourceRoutes(authorize).fetch(new Request(url, init));
    else if (path.startsWith(FLEET_RESOURCES_PATH))
      response = await resourceRoutes.fetch(new Request(url, init));
    else if (path.includes("fleet-settings")) response = await settingsRoutes.fetch(new Request(url, init));
    else response = new Response("missing", { status: 404 });
    outgoing.statusCode = response.status;
    response.headers.forEach((value, key) => outgoing.setHeader(key, value));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture unavailable");
  const host = `http://127.0.0.1:${address.port}`;
  const env = {
    HOME: directory,
    PATH: join(directory, "empty-bin"),
    XDG_CONFIG_HOME: join(directory, "config"),
    CLANKIE_SETTINGS_FILE: settings.path,
    CLANKIE_OPERATOR_TOKEN: token,
    CLANKIE_CONTROL_PLANE_URL: host,
  };
  await mkdir(env.PATH);
  const options = {
    settings,
    resourceGovernor: governor,
    operatorCredentialStore: credentials,
    host,
    env,
    cwd: directory,
  };
  const children: ChildProcess[] = [],
    completions: Promise<number>[] = [];
  async function headless(args: string[], nativeEnv: NodeJS.ProcessEnv = {}) {
    const script = join(directory, "headless.mjs");
    await writeFile(
      script,
      `import {createResourceGovernor} from ${JSON.stringify(pathToFileURL(join(repoRoot, "packages/fleet-resources/src/governor.ts")).href)};
import {runHeadlessCaptainCommand} from ${JSON.stringify(pathToFileURL(join(repoRoot, "apps/tui/bin/headless-captain.ts")).href)};
import {parseDirectConversation} from ${JSON.stringify(pathToFileURL(join(repoRoot, "apps/tui/src/session/operator-conversations.ts")).href)};
const governor=createResourceGovernor({directory:${JSON.stringify(join(directory, "registry"))},probe:async()=>({loadRatio:0,availableMemoryMb:1e6})});
try {process.exitCode=await runHeadlessCaptainCommand(parseDirectConversation(process.argv.slice(2)).remaining,{repoRoot:${JSON.stringify(repoRoot)},env:process.env,resourceGovernor:governor});} finally {await governor.close();}
`,
    );
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env, ...nativeEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const output: string[] = [];
    child.stdout?.on("data", (piece) => output.push(String(piece)));
    child.stderr?.on("data", (piece) => output.push(String(piece)));
    const done = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
    });
    void done.catch(() => undefined);
    completions.push(done);
    return { child, done, output };
  }
  return {
    directory,
    settings,
    credentials,
    token,
    get governor() {
      return governor;
    },
    get resources() {
      return resources;
    },
    async restartResources() {
      await resources.close();
      governor = createResourceGovernor({ directory: join(directory, "registry"), probe: calmPressure });
      resources = await createFleetResourceRuntime({
        governor,
        holderNoticeDirectory: join(directory, "holder-notices"),
        policy: async () => (await settings.load()).fleet.resources,
      });
      options.resourceGovernor = governor;
      resourceRoutes = createFleetResourceRoutes(authorize, resources);
    },
    calls,
    options,
    host,
    env,
    headless,
    mode: (value: typeof mode) => {
      mode = value;
    },
    async close() {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.allSettled(completions);
      await resources.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("fleet resource CLI and doctor across real OS/files/HTTP boundaries", () => {
  it("headless custom servers surface through authenticated status and doctor; holder alerts reach the seat's lead once", async () => {
    const f = await fixture();
    const alerts: { pane: string; text: string }[] = [];
    let acceptAlert = false;
    let holdDelivery = false;
    const deliveries = new Set<() => void>();
    const releaseDelivery = () => {
      for (const release of deliveries) release();
      deliveries.clear();
    };
    const lead = createServer(async (incoming, outgoing) => {
      const bytes: Buffer[] = [];
      for await (const piece of incoming) bytes.push(Buffer.from(piece));
      alerts.push(JSON.parse(Buffer.concat(bytes).toString("utf8")));
      if (holdDelivery) await new Promise<void>((resolve) => deliveries.add(resolve));
      outgoing.statusCode = acceptAlert ? 200 : 503;
      outgoing.end();
    });
    lead.listen(0, "127.0.0.1");
    await once(lead, "listening");
    const leadPort = (lead.address() as { port: number }).port;
    try {
      const resolver = {
        resolve: async () => undefined,
        proof: async () => undefined,
        isLocalFleet: async () => true,
        notify: async (pane: string, text: string) =>
          (
            await fetch(`http://127.0.0.1:${leadPort}`, {
              method: "POST",
              body: JSON.stringify({ pane, text }),
            })
          ).ok,
      };
      const roster = [{ seatId: "server-seat", paneId: "owned-pane", status: "working" }];
      f.resources.bindSeats(resolver);
      await f.resources.observeSeats(roster);
      const path = join(f.directory, "server.json");
      const run = await f.headless([
        "heavy",
        "--server",
        "--seat",
        "server-seat",
        "--holder",
        "owned-service",
        "--",
        process.execPath,
        join(repoRoot, "packages/fleet-resources/test/fixtures/server-command.mjs"),
        path,
      ]);
      await eventually(() => exists(path), Boolean, run);
      const { port } = JSON.parse(await readFile(path, "utf8")) as { port: number };
      await f.resources.refresh();
      const status = await runResourceStatusCommand(f.options);
      expect(status.capacity).toMatchObject({ used: 0, serverUsed: 1 });
      expect(status.serverLeases?.[0]).toMatchObject({ holderId: "owned-service", seatId: "server-seat" });
      expect(status.holderAlerts?.[0]).toMatchObject({ lane: "server", reason: "server" });
      expect(alerts).toHaveLength(0); // Status is immediate; lead notices wait for the threshold.
      await Promise.all([f.resources.refresh(), f.resources.observeSeats(roster)]);
      expect(alerts).toHaveLength(0);
      await new ResourceStore(join(f.directory, "registry/server")).transaction((state) => {
        const lease = state.leases.find((lease) => lease.holderId === "owned-service")!;
        lease.createdAtMs = Date.now() - longHeldJobMs - 1000;
      });
      await f.resources.refresh();
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ pane: "owned-pane", text: expect.stringContaining("owned-service") });
      acceptAlert = true;
      holdDelivery = true;
      const delivering = f.resources.refresh();
      await eventually(
        async () => alerts.length,
        (count) => count === 2,
      );
      // A real HTTP delivery is pending while roster observations independently
      // notice the same holder. Only its exclusive persistent claim may send.
      await Promise.all(Array.from({ length: 4 }, () => f.resources.observeSeats(roster)));
      expect(alerts).toHaveLength(2);
      holdDelivery = false;
      releaseDelivery();
      await delivering;
      await f.resources.refresh();
      expect(alerts).toHaveLength(2); // Failed delivery retried; successful delivery deduplicated.
      await f.restartResources();
      f.resources.bindSeats(resolver);
      await f.resources.observeSeats(roster);
      await f.resources.refresh();
      expect(alerts).toHaveLength(2); // New runtime and governor, same holder and persisted claim.
      process.stdout.write(
        `Holder alert proof: ${JSON.stringify({ freshHolderNotices: 0, rejectedAttempts: 1, concurrentRosterReads: 4, acceptedNoticesAfterRestart: alerts.length - 1 })}\n`,
      );
      // CPU status crosses the real private sidecar -> snapshot -> validated
      // HTTP/CLI -> doctor boundary. A stale runner birth cannot name this lease.
      const holder = status.serverLeases![0]!;
      const runner = (await processIdentity(holder.pid!))!;
      const cpuDirectory = join(f.directory, "registry/server/cpu");
      const cpuStatus = join(cpuDirectory, `${holder.id}.json`);
      const sinceMs = Date.now() - 120_000;
      await mkdir(cpuDirectory, { recursive: true });
      await writeFile(cpuStatus, JSON.stringify({ pid: runner.pid, startTime: "stale", sinceMs }));
      await f.resources.refresh();
      expect(
        (await runResourceStatusCommand(f.options)).serverLeases![0]!.cpuLimitUnenforcedSinceMs,
      ).toBeUndefined();
      await writeFile(cpuStatus, JSON.stringify({ pid: runner.pid, startTime: runner.startTime, sinceMs }));
      await f.resources.refresh();
      expect((await runResourceStatusCommand(f.options)).serverLeases![0]!.cpuLimitUnenforcedSinceMs).toBe(
        sinceMs,
      );
      const report = await doctorCommand({
        repoRoot: f.directory,
        settings: f.settings,
        env: f.env,
        host: f.host,
        credentialStore: f.credentials,
      });
      expect(formatDoctorReport(report)).toContain("owned-service");
      expect(formatDoctorReport(report)).toContain("CPU cores");
      expect(formatDoctorReport(report)).toContain("WARNING: CPU limit not enforced");
      await unlink(cpuStatus);
      await f.resources.refresh();
      expect(
        (await runResourceStatusCommand(f.options)).serverLeases![0]!.cpuLimitUnenforcedSinceMs,
      ).toBeUndefined();

      // An old full-lane job also reaches the lead and keeps its listener alive.
      const boundedPath = join(f.directory, "bounded.json");
      const bounded = await f.headless([
        "heavy",
        "--seat",
        "server-seat",
        "--holder",
        "old-build",
        "--",
        process.execPath,
        join(repoRoot, "packages/fleet-resources/test/fixtures/server-command.mjs"),
        boundedPath,
      ]);
      await eventually(() => exists(boundedPath), Boolean, bounded);
      await new ResourceStore(join(f.directory, "registry")).transaction((state) => {
        const lease = state.leases.find((lease) => lease.kind === "heavy" && lease.holderId === "old-build")!;
        lease.createdAtMs = Date.now() - longHeldJobMs - 1000;
      });
      await f.resources.refresh();
      expect(alerts).toHaveLength(3);
      expect(alerts[2]!.text).toContain("old-build");
      expect(alerts[2]!.text).toContain("has not been killed");
      const boundedPort = (JSON.parse(await readFile(boundedPath, "utf8")) as { port: number }).port;
      expect((await fetch(`http://127.0.0.1:${boundedPort}`)).ok).toBe(true);
      await fetch(`http://127.0.0.1:${boundedPort}/stop`);
      expect(await bounded.done).toBe(7);
      await fetch(`http://127.0.0.1:${port}/stop`);
      expect(await run.done).toBe(7);
    } finally {
      releaseDelivery();
      await f.close();
      lead.closeAllConnections();
      await new Promise<void>((resolve) => lead.close(() => resolve()));
    }
  }, 120_000);

  it("runs actual headless heavy locally in hosted mode, preserves child --chat args and nonzero exit", async () => {
    const f = await fixture();
    try {
      await runFleetCommand(
        ["set", "--heavy-slots", "1", "--max-load-ratio", "16", "--minimum-free-memory-mb", "0"],
        f.options,
      );
      f.calls.length = 0;
      await f.settings.update((settings) => ({
        ...settings,
        client: { mode: "hosted", gatewayUrl: f.host, hostId: "fixture-host-0123456789" },
      }));
      const receipt = join(f.directory, "args.json");
      const run = await f.headless([
        "heavy",
        "--",
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)));process.exit(41)",
        receipt,
        "--chat",
        "child-native-room",
        "--keep-this",
      ]);
      expect(await run.done, run.output.join("")).toBe(41);
      expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual([
        "--chat",
        "child-native-room",
        "--keep-this",
      ]);
      expect(
        (
          await eventually(
            () => f.governor.snapshot(),
            (snapshot) => snapshot.capacity.used === 0,
          )
        ).capacity.used,
      ).toBe(0);
      expect(f.calls.filter((call) => call.method === "POST")).toEqual([]);
    } finally {
      await f.close();
    }
  }, 20_000);

  it("passes Ctrl-C through the actual heavy CLI to the owned native command", async () => {
    const f = await fixture();
    try {
      await runFleetCommand(
        ["set", "--heavy-slots", "1", "--max-load-ratio", "16", "--minimum-free-memory-mb", "0"],
        f.options,
      );
      const receipt = join(f.directory, "signal-ready.json");
      const run = await f.headless([
        "heavy",
        "--",
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)",
        receipt,
      ]);
      await eventually(() => exists(receipt), Boolean, run);
      const { pid } = JSON.parse(await readFile(receipt, "utf8")) as { pid: number };
      run.child.kill("SIGINT");
      expect(await run.done, run.output.join("")).toBe(130);
      expect(await processIdentity(pid)).toBeUndefined();
      expect(
        (
          await eventually(
            () => f.governor.snapshot(),
            (snapshot) => snapshot.capacity.used === 0,
          )
        ).capacity.used,
      ).toBe(0);
    } finally {
      await f.close();
    }
  }, 20_000);

  it("persists owner overrides into real settings and the common registry, and clears them back to automatic", async () => {
    const f = await fixture();
    try {
      const saved = await runFleetCommand(
        [
          "set",
          "--heavy-slots",
          "3",
          "--simulator-slots",
          "2",
          "--simulator-idle-seconds",
          "90",
          "--max-load-ratio",
          "2",
          "--minimum-free-memory-mb",
          "512",
          "--minimum-free-disk-gb",
          "30",
          "--warn-free-disk-gb",
          "250",
          "--warn-free-disk-percent",
          "12",
        ],
        f.options,
      );
      expect(saved.fleet.resources).toEqual({
        heavySlots: 3,
        simulatorSlots: 2,
        simulatorIdleMs: 90_000,
        maxLoadRatio: 2,
        minAvailableMemoryMb: 512,
        minFreeDiskGb: 30,
        warnFreeDiskGb: 250,
        warnFreeDiskPercent: 12,
      });
      const independent = createResourceGovernor({
        directory: join(f.directory, "registry"),
        probe: calmPressure,
      });
      try {
        expect((await independent.snapshot()).policy).toEqual(saved.fleet.resources);
      } finally {
        await independent.close();
      }
      expect((await new SettingsStore(f.settings.path).load()).fleet.resources).toEqual(
        saved.fleet.resources,
      );
      const bytes = await readFile(f.settings.path, "utf8");
      await expect(runFleetCommand(["set", "--heavy-slots", "0"], f.options)).rejects.toThrow();
      await expect(
        runFleetCommand(["set", "--heavy-slots", "2", "--heavy-slots", "3"], f.options),
      ).rejects.toThrow("Usage");
      expect(await readFile(f.settings.path, "utf8")).toBe(bytes);
      await runFleetCommand(["clear"], f.options);
      // Settings keep "automatic"; the shared registry, read by every installed
      // CLI, holds the exact count it resolves to (VUH-1988).
      expect((await f.governor.snapshot()).policy).toEqual({
        ...defaultResourcePolicy(),
        simulatorSlots: automaticSimulatorSlots(),
      });
      expect((await f.settings.load()).fleet.resources).toEqual({
        ...defaultResourcePolicy(),
        simulatorSlots: null,
      });
    } finally {
      await f.close();
    }
  }, 20_000);

  it("reads legacy settings without introducing resource configuration or mutating files", async () => {
    const f = await fixture();
    try {
      await writeFile(
        f.settings.path,
        JSON.stringify({ schemaVersion: 1, fleet: { notes: "legacy owner notes", size: "small" } }),
      );
      const bytes = await readFile(f.settings.path, "utf8");
      const status = await runFleetCommand(["status"], f.options);
      expect(status.fleet).toMatchObject({ notes: "legacy owner notes", size: "small" });
      expect(status.fleet.resources).toBeUndefined();
      expect(FleetResourcePolicySchema.parse(status.fleet.resources ?? {})).toEqual({
        ...defaultResourcePolicy(),
        simulatorSlots: null,
      });
      expect(await readFile(f.settings.path, "utf8")).toBe(bytes);
    } finally {
      await f.close();
    }
  });

  it("shows a real holder PID and named FIFO waiter in authenticated doctor status without secrets", async () => {
    const f = await fixture();
    let release: string | undefined;
    const jobs: Promise<number>[] = [];
    const cancellation = new AbortController();
    const track = (job: Promise<number>) => {
      void job.catch(() => undefined);
      jobs.push(job);
    };
    try {
      await runFleetCommand(
        ["set", "--heavy-slots", "1", "--max-load-ratio", "16", "--minimum-free-memory-mb", "0"],
        f.options,
      );
      const receipt = join(f.directory, "doctor-ready.json");
      release = join(f.directory, "doctor-release");
      track(
        f.governor.runHeavy(
          process.execPath,
          [
            "-e",
            "const fs=require('node:fs');fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));const t=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(t)}},20)",
            receipt,
            release,
          ],
          { signal: cancellation.signal },
        ),
      );
      await eventually(() => exists(receipt), Boolean, { done: jobs[0]!, output: [] });
      track(
        f.governor.runHeavy(process.execPath, ["-e", "process.exit(0)"], {
          seatId: "Bex",
          signal: cancellation.signal,
        }),
      );
      await eventually(
        () => f.governor.snapshot(),
        (snapshot) => snapshot.queue.length === 1,
      );
      await f.resources.refresh();
      const status = await runResourceStatusCommand(f.options);
      expect(status.leases[0]!.pid).toBeGreaterThan(1);
      expect(status.queue[0]).toMatchObject({ seatId: "Bex", kind: "heavy" });
      await runFleetCommand(["set", "--warn-free-disk-gb", "1048576"], f.options);
      const report = await doctorCommand({
        repoRoot: f.directory,
        settings: f.settings,
        env: f.env,
        host: f.host,
        credentialStore: f.credentials,
      });
      const rendered = formatDoctorReport(report);
      expect(rendered).toContain("Low disk");
      expect(
        report.resources && "pressure" in report.resources && report.resources.pressure.freeDiskGb,
      ).toBeGreaterThan(0);
      expect(rendered).toContain(`PID ${status.leases[0]!.pid}`);
      expect(rendered).toContain(`Queued Bex · heavy ${basename(process.execPath)}`);
      expect(rendered).toContain("1/1 heavy");
      expect(JSON.stringify(report)).not.toContain(f.token);
      const wrong = { ...f.options, env: { ...f.env, CLANKIE_OPERATOR_TOKEN: mintOperatorToken() } };
      await expect(runResourceStatusCommand(wrong)).rejects.toThrow("HTTP 401");
      const before = f.calls.length;
      await expect(
        runSimulatorCommand(
          [
            "acquire",
            JSON.stringify({
              seatId: "Bex",
              occupantId: "caller-forged",
              deviceType: "fixture",
              runtime: "fixture",
            }),
          ],
          f.options,
        ),
      ).rejects.toThrow();
      expect(f.calls.length).toBe(before);
    } finally {
      cancellation.abort();
      if (release) await writeFile(release, "release");
      await Promise.allSettled(jobs);
      await f.close();
    }
  }, 20_000);

  it.each(["legacy", "invalid", "unavailable"] as const)(
    "keeps doctor usable when resource status is %s",
    async (mode) => {
      const f = await fixture();
      try {
        f.mode(mode);
        const report = await doctorCommand({
          repoRoot: f.directory,
          settings: f.settings,
          env: f.env,
          host: f.host,
          credentialStore: f.credentials,
        });
        expect(report.ok).toBe(true);
        expect(report.captain).toMatchObject({ ready: false, reason: "no_model" });
        expect(report.resources).toMatchObject({ status: "unavailable" });
        const rendered = formatDoctorReport(report);
        expect(rendered).toContain("Captain · no model selected");
        expect(rendered).toContain("Fleet resources · unavailable");
        expect(rendered).not.toContain("Bearer-response-secret");
        expect(rendered).not.toContain(f.token);
      } finally {
        await f.close();
      }
    },
    15_000,
  );

  it("bounds a stalled real resource HTTP read to five seconds without losing doctor diagnostics", async () => {
    const f = await fixture();
    try {
      f.mode("stalled");
      const started = Date.now();
      const report = await doctorCommand({
        repoRoot: f.directory,
        settings: f.settings,
        env: f.env,
        host: f.host,
        credentialStore: f.credentials,
      });
      expect(Date.now() - started).toBeLessThan(6_500);
      expect(report.resources).toMatchObject({ status: "unavailable" });
      expect(report.captain).toMatchObject({ ready: false, reason: "no_model" });
    } finally {
      await f.close();
    }
  }, 15_000);
});

it("a heavy CLI behind another waiter says it is queued; the head of the queue names the slots", async () => {
  const f = await fixture();
  try {
    await f.governor.configure({
      ...defaultResourcePolicy(),
      heavySlots: 1,
      maxLoadRatio: 16,
      minAvailableMemoryMb: 0,
    });
    const marker = join(f.directory, "queue-label-ready");
    const release = join(f.directory, "queue-label-release");
    const holder = await f.headless([
      "heavy",
      "--",
      process.execPath,
      "-e",
      "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'ready');const t=setInterval(()=>{if(fs.existsSync(process.argv[2]))clearInterval(t)},20)",
      marker,
      release,
    ]);
    await eventually(() => exists(marker), Boolean, holder);
    const head = await f.headless(["heavy", "--", process.execPath, "-e", "process.exit(0)"]);
    await eventually(
      () => f.governor.snapshot(),
      (value) => value.queue.length === 1,
    );
    const behind = await f.headless(["heavy", "--", process.execPath, "-e", "process.exit(0)"]);
    await eventually(
      async () => behind.output.join(""),
      (text) => text.includes("waiting for machine capacity"),
    );
    await eventually(
      async () => head.output.join(""),
      (text) => text.includes("waiting for machine capacity"),
    );
    expect(head.output.join("")).toContain("(slots; 1/1 held");
    expect(behind.output.join("")).toContain("(queued; 1/1 held, 2 queued)");
    await writeFile(release, "done");
    expect(await holder.done).toBe(0);
    expect(await head.done).toBe(0);
    expect(await behind.done).toBe(0);
  } finally {
    await f.close();
  }
});

it("a heavy CLI waiting on the service's admission says so, not busy", async () => {
  const f = await fixture();
  // The service's arbiter judges the machine busy (VUH-2080), so it grants nothing.
  const arbiter = createResourceGovernor({
    directory: join(f.directory, "registry"),
    probe: async () => ({ loadRatio: 99, cpuRatio: 1, availableMemoryMb: 1_000_000 }),
  });
  const passes = setInterval(() => void arbiter.arbitrate().catch(() => {}), 200);
  try {
    await f.governor.configure({ ...defaultResourcePolicy(), heavySlots: 1, minAvailableMemoryMb: 0 });
    await arbiter.arbitrate();
    const run = await f.headless(["heavy", "--", process.execPath, "-e", "process.exit(0)"]);
    await eventually(
      async () => run.output.join(""),
      (text) => text.includes("waiting for machine capacity"),
    );
    expect(run.output.join("")).toContain("(service; 0/1 held, 1 queued)");
    clearInterval(passes);
    // Without the arbiter's heartbeat the waiter judges for itself and starts.
    expect(await run.done).toBe(0);
  } finally {
    clearInterval(passes);
    await arbiter.close();
    await f.close();
  }
}, 20_000);

it("native child heavy CLIs under the same pane keep separate holder labels and permits", async () => {
  const f = await fixture();
  try {
    await f.governor.configure({
      ...defaultResourcePolicy(),
      heavySlots: 1,
      maxLoadRatio: 16,
      minAvailableMemoryMb: 0,
    });
    const marker = join(f.directory, "child-heavy-ready");
    const release = join(f.directory, "child-heavy-release");
    const first = await f.headless(
      [
        "heavy",
        "--",
        process.execPath,
        "-e",
        "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'ready');const t=setInterval(()=>{if(fs.existsSync(process.argv[2]))clearInterval(t)},20)",
        marker,
        release,
      ],
      {
        HERDR_PANE_ID: "parent-seat",
        CLANKIE_RESOURCE_HOLDER: "claude:parent:agent:dock",
        CODEX_THREAD_ID: undefined,
      },
    );
    await eventually(() => exists(marker), Boolean, first);
    const second = await f.headless(["heavy", "--", process.execPath, "-e", "process.exit(0)"], {
      HERDR_PANE_ID: "parent-seat",
      CLANKIE_RESOURCE_HOLDER: "",
      CODEX_THREAD_ID: "cards-thread",
    });
    // Empty explicit identity fails closed instead of merging with the parent.
    expect(await second.done).toBe(1);
    const third = await f.headless(["heavy", "--", process.execPath, "-e", "process.exit(0)"], {
      HERDR_PANE_ID: "parent-seat",
      CLANKIE_RESOURCE_HOLDER: "codex:parent-thread",
      CODEX_THREAD_ID: "cards-thread",
    });
    const snapshot = await eventually(
      () => f.governor.snapshot(),
      (value) => value.queue.length === 1,
    );
    expect(snapshot.leases[0]).toMatchObject({ seatId: "parent-seat", holderId: "claude:parent:agent:dock" });
    expect(snapshot.queue[0]).toMatchObject({ seatId: "parent-seat", holderId: "codex:cards-thread" });
    expect(third.child.exitCode).toBeNull();
    await writeFile(release, "done");
    expect(await first.done, first.output.join("")).toBe(0);
    expect(await third.done, third.output.join("")).toBe(0);
  } finally {
    await f.close();
  }
});
