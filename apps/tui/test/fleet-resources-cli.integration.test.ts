import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { createResourceGovernor, defaultResourcePolicy, processIdentity } from "@clankie/fleet-resources";
import { FLEET_RESOURCES_PATH, FleetResourcePolicySchema } from "@clankie/protocol";
import { createFleetResourceRuntime } from "../../clankie/src/fleet-resource-runtime.ts";
import { createFleetResourceRoutes } from "../../clankie/src/fleet-resource-routes.ts";
import { createFleetSettingsRoutes } from "../../clankie/src/fleet-settings-routes.ts";
import { runFleetCommand } from "../src/command/fleet.ts";
import { runResourceStatusCommand, runSimulatorCommand } from "../src/command/fleet-resources.ts";
import { doctorCommand } from "../src/command/doctor.ts";
import { formatDoctorReport } from "../src/doctor-report.ts";

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
  const governor = createResourceGovernor({ directory: join(directory, "registry"), probe: calmPressure });
  const resources = await createFleetResourceRuntime({
    governor,
    policy: async () => (await settings.load()).fleet.resources,
  });
  const authorize = async (request: Request) =>
    request.headers.get("authorization") === `Bearer ${token}`
      ? (true as const)
      : ("authentication_required" as const);
  const resourceRoutes = createFleetResourceRoutes(authorize, resources);
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
    governor,
    resources,
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
        ],
        f.options,
      );
      expect(saved.fleet.resources).toEqual({
        heavySlots: 3,
        simulatorSlots: 2,
        simulatorIdleMs: 90_000,
        maxLoadRatio: 2,
        minAvailableMemoryMb: 512,
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
      expect((await f.governor.snapshot()).policy).toEqual(defaultResourcePolicy());
      expect((await f.settings.load()).fleet.resources).toEqual(defaultResourcePolicy());
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
      expect(FleetResourcePolicySchema.parse(status.fleet.resources ?? {})).toEqual(defaultResourcePolicy());
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
      const report = await doctorCommand({
        repoRoot: f.directory,
        settings: f.settings,
        env: f.env,
        host: f.host,
        credentialStore: f.credentials,
      });
      const rendered = formatDoctorReport(report);
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
    expect(await first.done).toBe(0);
    expect(await third.done).toBe(0);
  } finally {
    await f.close();
  }
});
