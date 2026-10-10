import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { FleetHealthMetrics } from "../src/fleet-health-metrics.ts";
import { fleetProcessHelper, NativeProcessDiagnosticSchema } from "../src/local-fleet-process.ts";
import { closeNativeProcessObservers, nativeProcessRequest } from "../src/native-process-transport.ts";

const manual = process.platform === "darwin" && process.env.FLEET_ADDITIONAL_OS_TEST === "1";
const run = promisify(execFile);
async function capture(binary: string, args: string[], metrics: FleetHealthMetrics) {
  const result = await run(binary, args, { timeout: 5_000 }).catch(
    (error: { code: number; stdout: string; stderr: string }) => {
      expect(error.code).toBe(1);
      return error;
    },
  );
  expect(result.stdout).toBe("");
  const events = result.stderr
    .split("\n")
    .filter((line) => line.startsWith("Native process proof diagnostic: "))
    .map((line) =>
      NativeProcessDiagnosticSchema.parse(JSON.parse(line.slice("Native process proof diagnostic: ".length))),
    );
  for (const event of events)
    metrics.observeProof("fleet", { source: "native", checkpoint: "initial", event });
  return events;
}

it.skipIf(!manual)(
  "counts a real non-Codex executable refusal on an owned Unix listener",
  async () => {
    const directory = resolve(".local/1704", `executable-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    const helper = fleetProcessHelper();
    if (!helper) throw new Error("Build the production helper first");
    const socketRoot = await mkdtemp("/tmp/clankie-exe-");
    const path = resolve(socketRoot, "owned.sock");
    const server = createServer().listen(path);
    await once(server, "listening");
    const metrics = new FleetHealthMetrics();
    try {
      const events = await capture(
        helper,
        [
          "--codex-server",
          String(process.pid),
          Buffer.from(`unix://${path}`).toString("hex"),
          Buffer.from(path).toString("hex"),
          "--diagnostics",
        ],
        metrics,
      );
      expect(events.some((event) => event.reason === "executable_unavailable")).toBe(true);
      expect(metrics.snapshot().totals.nativeDiagnostics.executable_unavailable).toBe(1);
      await writeFile(
        resolve(directory, "evidence.json"),
        JSON.stringify({ events, metrics: metrics.snapshot() }, null, 2),
      );
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      await rm(socketRoot, { recursive: true, force: true });
    }
  },
  30_000,
);

it.skipIf(!manual)(
  "reads an actual oversized FD table whole on a real TCP owner and counts it",
  async () => {
    const directory = resolve(".local/1704", `fd-bounds-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    const helper = fleetProcessHelper();
    if (!helper) throw new Error("Build the production helper first");
    const fixture = resolve(directory, "fd-bounds");
    await run("cc", [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "apps/clankie/test/helpers/native-proof-churn/fd-bounds.c",
      "-o",
      fixture,
    ]);
    const server = createServer().listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing real listener");
    const connected = once(server, "connection");
    const child = spawn(fixture, [String(address.port)], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = once(child, "exit");
    let peer: Socket | undefined;
    let output = "";
    child.stdout.on("data", (bytes) => {
      output += bytes.toString();
    });
    try {
      [peer] = (await Promise.race([
        connected,
        exited.then(() => {
          throw new Error("Owned FD fixture exited before connecting");
        }),
      ])) as [Socket];
      for (let attempt = 0; attempt < 100 && !output.includes("ready"); attempt++)
        await new Promise((done) => setTimeout(done, 5));
      expect(output).toContain("ready");
      const metrics = new FleetHealthMetrics();
      // Past the first 16,384 records the table is read whole, never refused or skipped (VUH-2070).
      const result = await run(helper, [String(peer!.remotePort), String(address.port), "--diagnostics"], {
        timeout: 5_000,
      });
      expect(JSON.parse(result.stdout).owner.pid).toBe(child.pid);
      const events = result.stderr
        .split("\n")
        .filter((line) => line.startsWith("Native process proof diagnostic: "))
        .map((line) =>
          NativeProcessDiagnosticSchema.parse(
            JSON.parse(line.slice("Native process proof diagnostic: ".length)),
          ),
        );
      for (const event of events)
        metrics.observeProof("fleet", { source: "native", checkpoint: "initial", event });
      expect(events.find((event) => event.reason === "fd_list_large")?.largeFdTable?.pid).toBe(child.pid);
      expect(metrics.snapshot().totals.nativeDiagnostics.fd_list_large).toBe(1);
      await writeFile(
        resolve(directory, "evidence.json"),
        JSON.stringify({ events, metrics: metrics.snapshot() }, null, 2),
      );
    } finally {
      child.stdin.end();
      expect(await exited).toEqual([0, null]);
      peer?.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
  30_000,
);

it.skipIf(!manual).each(["executable", "argv"] as const)(
  "retains actual %s change diagnostics from bounded owned process changes",
  async (mode) => {
    const directory = resolve(".local/1704", `exec-changes-${mode}-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    const helper = fleetProcessHelper();
    if (!helper) throw new Error("Build the production helper first");
    const a = resolve(directory, "owned-a"),
      b = resolve(directory, "owned-b");
    await run("cc", [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "apps/clankie/test/helpers/native-proof-churn/exec-changes.c",
      "-o",
      a,
    ]);
    await copyFile(a, b);
    const child = spawn(a, [a, b, "0", "start", mode], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = once(child, "exit");
    const metrics = new FleetHealthMetrics();
    const reason = mode === "argv" ? "argv_changed" : "executable_changed";
    const evidence = [];
    try {
      await Promise.race([
        once(child.stdout, "data"),
        exited.then(() => {
          throw new Error("Owned exec fixture exited before readiness");
        }),
      ]);
      for (let attempt = 0; attempt < 4096 && child.exitCode === null; attempt++) {
        const reply = await nativeProcessRequest(helper, [
          "--processes",
          String(process.pid),
          String(child.pid),
          "--diagnostics",
        ]);
        if (!reply) throw new Error("Actual process observer transport unavailable");
        const events = reply.stderr
          .split("\n")
          .filter((line) => line.startsWith("Native process proof diagnostic: "))
          .map((line) =>
            NativeProcessDiagnosticSchema.parse(
              JSON.parse(line.slice("Native process proof diagnostic: ".length)),
            ),
          );
        for (const event of events)
          metrics.observeProof("project", { source: "native", checkpoint: "initial", event });
        evidence.push({ attempt, refused: reply.stdout === "", events });
        const counts = metrics.snapshot().totals.nativeDiagnostics;
        if (counts[reason]) break;
      }
      await writeFile(
        resolve(directory, "evidence.json"),
        JSON.stringify({ evidence, metrics: metrics.snapshot() }, null, 2),
      );
      expect(metrics.snapshot().totals.nativeDiagnostics[reason]).toBeGreaterThan(0);
    } finally {
      child.stdin.end();
      expect(await exited).toEqual([0, null]);
      await closeNativeProcessObservers();
    }
  },
  30_000,
);

it.skipIf(!manual)(
  "counts a real parent exit during an owned child's kernel process proof",
  async () => {
    const directory = resolve(".local/1704", `reparent-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    const helper = fleetProcessHelper();
    if (!helper) throw new Error("Build the production helper first");
    const fixture = resolve(directory, "reparent");
    await run("cc", [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "apps/clankie/test/helpers/native-proof-churn/reparent.c",
      "-o",
      fixture,
    ]);
    const metrics = new FleetHealthMetrics();
    const evidence = [];
    try {
      await nativeProcessRequest(helper, ["--birth", String(process.pid), "--diagnostics"]);
      for (let attempt = 0; attempt < 512; attempt++) {
        const delayUs = (attempt % 32) * 100;
        const child = spawn(fixture, [String(delayUs)], { stdio: ["pipe", "pipe", "pipe"] });
        // close waits for the bounded leaf's inherited pipe as well as the parent.
        const exited = once(child, "close");
        try {
          const [bytes] = await Promise.race([
            once(child.stdout, "data"),
            exited.then(() => {
              throw new Error("Owned parent exited before readiness");
            }),
          ]);
          const pid = Number(bytes.toString().trim());
          if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid actual child identity");
          const observing = nativeProcessRequest(helper, [
            "--processes",
            String(process.pid),
            String(pid),
            "--diagnostics",
          ]);
          child.stdin.end();
          let reply = await observing;
          for (let observation = 0; observation < 64; observation++) {
            if (!reply) throw new Error("Actual process observer unavailable");
            const events = reply.stderr
              .split("\n")
              .filter((line) => line.startsWith("Native process proof diagnostic: "))
              .map((line) => NativeProcessDiagnosticSchema.parse(JSON.parse(line.slice(33))));
            for (const event of events)
              metrics.observeProof("project", { source: "native", checkpoint: "initial", event });
            evidence.push({ attempt, observation, delayUs, refused: reply.stdout === "", events });
            if (metrics.snapshot().totals.nativeDiagnostics.process_changed || child.exitCode !== null) break;
            reply = await nativeProcessRequest(helper, [
              "--processes",
              String(pid),
              String(process.pid),
              "--diagnostics",
            ]);
          }
        } finally {
          child.stdin.end();
          expect(await exited).toEqual([0, null]);
        }
        if (metrics.snapshot().totals.nativeDiagnostics.process_changed) break;
      }
      await writeFile(
        resolve(directory, "evidence.json"),
        JSON.stringify({ evidence, metrics: metrics.snapshot() }, null, 2),
      );
      expect(metrics.snapshot().totals.nativeDiagnostics.process_changed).toBeGreaterThan(0);
    } finally {
      await closeNativeProcessObservers();
    }
  },
  30_000,
);

it.skipIf(!manual)(
  "counts real exited and changing ancestry during owned root exits",
  async () => {
    const directory = resolve(".local/1704", `ancestry-race-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    const helper = fleetProcessHelper();
    if (!helper) throw new Error("Build the production helper first");
    const fixture = resolve(directory, "ancestry-race");
    await run("cc", [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "apps/clankie/test/helpers/native-proof-churn/ancestry-race.c",
      "-o",
      fixture,
    ]);
    const server = createServer().listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing real listener");
    const metrics = new FleetHealthMetrics();
    const evidence = [];
    try {
      await nativeProcessRequest(helper, ["--birth", String(process.pid), "--diagnostics"]);
      for (let attempt = 0; attempt < 256; attempt++) {
        const delayUs = (attempt % 32) * 1000;
        const connecting = once(server, "connection");
        const child = spawn(fixture, [String(address.port), String(delayUs)], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        const exited = once(child, "close");
        let peer: Socket | undefined;
        try {
          [peer] = (await Promise.race([
            connecting,
            exited.then(() => {
              throw new Error("Owned ancestry fixture exited before connecting");
            }),
          ])) as [Socket];
          const observing = nativeProcessRequest(helper, [
            String(peer.remotePort),
            String(address.port),
            "--diagnostics",
          ]);
          child.stdin.end();
          let reply = await observing;
          for (let observation = 0; observation < 64; observation++) {
            if (!reply) throw new Error("Actual socket observer unavailable");
            const events = reply.stderr
              .split("\n")
              .filter((line) => line.startsWith("Native process proof diagnostic: "))
              .map((line) => NativeProcessDiagnosticSchema.parse(JSON.parse(line.slice(33))));
            for (const event of events)
              metrics.observeProof("fleet", { source: "native", checkpoint: "initial", event });
            evidence.push({ attempt, observation, delayUs, refused: reply.stdout === "", events });
            const counts = metrics.snapshot().totals.nativeDiagnostics;
            if ((counts.ancestor_exited && counts.ancestry_changed) || child.exitCode !== null) break;
            reply = await nativeProcessRequest(helper, [
              String(peer.remotePort),
              String(address.port),
              "--diagnostics",
            ]);
          }
        } finally {
          child.stdin.end();
          expect(await exited).toEqual([0, null]);
          peer?.destroy();
        }
        const counts = metrics.snapshot().totals.nativeDiagnostics;
        if (counts.ancestor_exited && counts.ancestry_changed) break;
      }
      await writeFile(
        resolve(directory, "evidence.json"),
        JSON.stringify({ evidence, metrics: metrics.snapshot() }, null, 2),
      );
      expect(metrics.snapshot().totals.nativeDiagnostics.ancestor_exited).toBeGreaterThan(0);
      expect(metrics.snapshot().totals.nativeDiagnostics.ancestry_changed).toBeGreaterThan(0);
    } finally {
      await closeNativeProcessObservers();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
  60_000,
);
