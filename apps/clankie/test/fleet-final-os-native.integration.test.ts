import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { FleetHealthMetrics } from "../src/fleet-health-metrics.ts";
import { fleetProcessHelper, NativeProcessDiagnosticSchema } from "../src/local-fleet-process.ts";

const manual = process.platform === "darwin" && process.env.FLEET_FINAL_OS_TEST === "1";
const run = promisify(execFile);
const diagnosticsFrom = (stderr: string) =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith("Native process proof diagnostic: "))
    .map((line) => NativeProcessDiagnosticSchema.parse(JSON.parse(line.slice(33))));

it.skipIf(!manual)(
  "counts a real denied retry wait while the original monotonic clock remains available",
  async () => {
    const directory = resolve(".local/final-os", `clock-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    const helper = fleetProcessHelper();
    if (!helper) throw new Error("Build the unchanged production helper first");
    const clock = resolve(directory, "clock-wait");
    const processes = resolve(directory, "processes");
    for (const [source, destination] of [
      ["clock-wait.c", clock],
      ["processes.c", processes],
    ] as const)
      await run("cc", [
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        `apps/clankie/test/helpers/native-proof-churn/${source}`,
        "-o",
        destination,
      ]);
    const baseline = JSON.parse((await run(clock)).stdout);
    expect(baseline.clockResult).toBe(0);
    expect(baseline.waitResult).toBe(0);
    const profile = resolve(directory, "wait-denied.sb");
    await writeFile(
      profile,
      `(version 1)\n(allow default)\n(deny syscall-unix ${baseline.waitSyscalls.map((id: number) => `(syscall-number ${id})`).join(" ")})\n`,
    );
    const denied = JSON.parse((await run("/usr/bin/sandbox-exec", ["-f", profile, clock])).stdout);
    expect(denied.clockResult).toBe(0);
    expect(denied.waitResult).toBe(-1);
    expect(denied.waitErrno).toBeGreaterThan(0);
    const server = createServer().listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing owned listener");
    const connecting = once(server, "connection");
    const client = createConnection(address.port, "127.0.0.1");
    const churn = spawn(processes, ["churn", "30"], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = once(churn, "exit");
    const metrics = new FleetHealthMetrics();
    const evidence = [];
    let peer: Socket | undefined;
    try {
      [peer] = (await connecting) as [Socket];
      await Promise.race([
        once(churn.stdout, "data"),
        exited.then(() => {
          throw new Error("Owned churn exited before readiness");
        }),
      ]);
      // Main's helper retries (and waits) only when one scanned PID changes
      // mid-observation, ~1 in 30 runs under this churn; bound at 512 runs.
      for (let attempt = 0; attempt < 512; attempt++) {
        const reply = await run(
          "/usr/bin/sandbox-exec",
          ["-f", profile, helper, String(client.localPort), String(address.port), "--diagnostics"],
          { timeout: 3000 },
        ).catch((error: { code: number; stdout: string; stderr: string }) => {
          expect(error.code).toBe(1);
          return error;
        });
        const events = diagnosticsFrom(reply.stderr);
        for (const event of events)
          metrics.observeProof("fleet", { source: "native", checkpoint: "initial", event });
        evidence.push({ attempt, refused: reply.stdout === "", events });
        if (events.some((event) => event.reason === "clock_unavailable")) {
          expect(reply.stdout).toBe("");
          break;
        }
      }
      await writeFile(
        resolve(directory, "evidence.json"),
        JSON.stringify({ baseline, denied, evidence, metrics: metrics.snapshot() }, null, 2),
      );
      const snapshot = metrics.snapshot();
      expect(snapshot.totals.nativeDiagnostics.clock_unavailable).toBeGreaterThan(0);
      expect(snapshot.totals.proof.attempts).toBe(0);
      for (const window of snapshot.windows)
        expect(window.nativeDiagnostics.clock_unavailable).toBeGreaterThan(0);
    } finally {
      churn.stdin.end();
      const status = await exited;
      client.destroy();
      peer?.destroy();
      await new Promise<void>((done) => server.close(() => done()));
      expect(status).toEqual([0, null]);
    }
  },
  60_000,
);

it.skipIf(!manual)(
  "counts direct defensive record guards without claiming OS producer evidence",
  async () => {
    const directory = resolve(".local/final-os", `guards-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    const executable = resolve(directory, "record-guards");
    await run("cc", [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-mmacosx-version-min=14.0",
      "apps/clankie/test/helpers/native-proof-churn/record-guards.c",
      "-lproc",
      "-o",
      executable,
    ]);
    const reply = await run(executable, { timeout: 3000 });
    const checks = reply.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(checks.at(-1)).toEqual({ cases: 11, failures: 0 });
    const events = diagnosticsFrom(reply.stderr);
    expect(events).toHaveLength(7);
    const metrics = new FleetHealthMetrics();
    for (const event of events)
      metrics.observeProof("fleet", { source: "native", checkpoint: "initial", event });
    const snapshot = metrics.snapshot();
    expect(snapshot.totals.nativeDiagnostics.fd_record_invalid).toBe(2);
    expect(snapshot.totals.nativeDiagnostics.socket_identity_invalid).toBe(5);
    expect(snapshot.totals.proof.attempts).toBe(0);
    for (const window of snapshot.windows) {
      expect(window.nativeDiagnostics.fd_record_invalid).toBe(2);
      expect(window.nativeDiagnostics.socket_identity_invalid).toBe(5);
    }
    await writeFile(
      resolve(directory, "evidence.json"),
      JSON.stringify(
        {
          scope: "defensive, not producible; direct validation inputs, not OS records",
          checks,
          events,
          metrics: snapshot,
        },
        null,
        2,
      ),
    );
  },
  60_000,
);

it.skipIf(!manual)(
  "counts an actual debugger parentage cycle and reaps its owned target after detach",
  async () => {
    const directory = resolve(".local/final-os", `cycle-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    const helper = fleetProcessHelper();
    if (!helper) throw new Error("Build the production helper first");
    const executable = resolve(directory, "ancestry-cycle");
    await run("cc", [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "apps/clankie/test/helpers/native-proof-churn/ancestry-cycle.c",
      "-lproc",
      "-o",
      executable,
    ]);
    const entitlements = resolve(directory, "debug.plist");
    await writeFile(
      entitlements,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.get-task-allow</key><true/>
<key>com.apple.security.cs.debugger</key><true/></dict></plist>\n`,
    );
    await run("codesign", ["--force", "--sign", "-", "--entitlements", entitlements, executable]);
    const server = createServer().listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing owned listener");
    const connecting = once(server, "connection");
    const fixture = spawn(executable, [String(address.port)], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = once(fixture, "close");
    let output = "";
    const ready = new Promise<void>((done, reject) => {
      fixture.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
        if (output.includes("attached 1 1\n")) done();
        else if (output.includes("attach refused")) reject(new Error(output));
      });
    });
    const prematureExit = exited.then(() => {
      throw new Error(`Owned fixture exited before readiness: ${output}`);
    });
    let peer: Socket | undefined;
    try {
      [peer] = (await Promise.race([connecting, prematureExit])) as [Socket];
      await Promise.race([ready, prematureExit]);
      if (!peer.remotePort) throw new Error("Missing owned client port");
      const reply = await run(helper, [String(peer.remotePort), String(address.port), "--diagnostics"], {
        timeout: 3000,
      }).catch((error: { code: number; stdout: string; stderr: string }) => {
        expect(error.code).toBe(1);
        return error;
      });
      expect(reply.stdout).toBe("");
      const events = diagnosticsFrom(reply.stderr);
      const metrics = new FleetHealthMetrics();
      for (const event of events)
        metrics.observeProof("fleet", { source: "native", checkpoint: "initial", event });
      const snapshot = metrics.snapshot();
      expect(snapshot.totals.nativeDiagnostics.ancestry_cycle).toBe(1);
      expect(snapshot.totals.proof.attempts).toBe(0);
      for (const window of snapshot.windows) expect(window.nativeDiagnostics.ancestry_cycle).toBe(1);
      fixture.stdin.end();
      expect(await exited).toEqual([0, null]);
      expect(output).toContain("reaped 0\n");
      await writeFile(
        resolve(directory, "evidence.json"),
        JSON.stringify(
          {
            kernelCycleConfirmed: output.includes("attached 1 1\n"),
            originalTargetReaped: output.includes("reaped 0\n"),
            refused: reply.stdout === "",
            events,
            metrics: snapshot,
          },
          null,
          2,
        ),
      );
    } finally {
      fixture.stdin.end();
      await exited;
      peer?.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
  60_000,
);
