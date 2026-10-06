import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { FleetHealthMetrics } from "../src/fleet-health-metrics.ts";
import { localFleetProof } from "../src/local-fleet-proof.ts";
import { fleetProcessHelper, NativeProcessDiagnosticSchema } from "../src/local-fleet-process.ts";
import { closeNativeProcessObservers } from "../src/native-process-transport.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

it.skipIf(process.platform !== "darwin" || process.env.FLEET_DEFENSIVE_OS_TEST !== "1")(
  "counts a real too-deep native process ancestry through the socket proof",
  async () => {
    const directory = resolve(".local/1704", `defensive-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    const herdr = await isolatedHerdr(directory);
    const helper = resolve(directory, "owned-processes");
    await promisify(execFile)("cc", [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "apps/clankie/test/helpers/native-proof-churn/processes.c",
      "-o",
      helper,
    ]);
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing owned listener");
    const connection = once(server, "connection");
    const child = spawn(helper, ["ancestry", String(address.port)], { stdio: ["ignore", "pipe", "pipe"] });
    const exit = once(child, "exit");
    let peer: Socket | undefined;
    try {
      [peer] = (await connection) as [Socket];
      const metrics = new FleetHealthMetrics();
      const diagnostics: unknown[] = [];
      const proof = localFleetProof({
        herdrBinary: "herdr",
        binding: async () => ({ runtime: "external", session: "default", socketPath: herdr.socketPath }),
        processHelper: fleetProcessHelper(),
        diagnostics: (event, pane) => {
          diagnostics.push(event);
          metrics.observeProof("fleet", event, pane);
        },
      });
      expect(await proof(peer!, herdr.pane)).toBe(false);
      await writeFile(resolve(directory, "diagnostics.json"), JSON.stringify(diagnostics, null, 2));
      const snapshot = metrics.snapshot();
      await writeFile(resolve(directory, "metrics.json"), JSON.stringify(snapshot, null, 2));
      expect(JSON.stringify(snapshot)).toContain('"ancestry_bounds":1');
      expect(JSON.stringify(diagnostics)).toContain('"reason":"ancestry_bounds"');
      expect(await exit).toEqual([0, null]);
    } finally {
      peer?.destroy();
      await new Promise<void>((done) => server.close(() => done()));
      await exit;
      closeNativeProcessObservers();
      await herdr.close();
    }
  },
  30_000,
);

it.skipIf(process.platform !== "darwin" || process.env.FLEET_DEFENSIVE_OS_TEST !== "1")(
  "counts real per-helper OS census, FD and argv access refusals without changing the host policy",
  async () => {
    const directory = resolve(".local/1704", `sandbox-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Owned listener unavailable");
    const connection = once(server, "connection");
    const client = createConnection(address.port, "127.0.0.1");
    const [peer] = (await connection) as [Socket];
    const helper = fleetProcessHelper();
    if (!helper) throw new Error("Build the real native process helper first");
    const metrics = new FleetHealthMetrics();
    const evidence: unknown[] = [];
    try {
      for (const [deny, args, reason] of [
        [
          "process-info-listpids",
          [String(client.localPort), String(address.port)],
          "process_census_unavailable",
        ],
        ["process-info-pidfdinfo", [String(client.localPort), String(address.port)], "fd_list_unavailable"],
        ["sysctl-read", ["--processes", String(process.pid), String(process.pid)], "argv_unavailable"],
      ] as const) {
        // Apple's sandbox applies only to this owned invocation of the unchanged
        // installed helper. Every denial below comes from an actual OS syscall.
        const result = await promisify(execFile)(
          "/usr/bin/sandbox-exec",
          ["-p", `(version 1)(allow default)(deny ${deny})`, helper, ...args, "--diagnostics"],
          { timeout: 5_000 },
        ).catch((error: { code: unknown; stderr: string; stdout: string }) => {
          expect(error.code).toBe(1);
          return error;
        });
        expect(result.stdout).toBe("");
        const events = result.stderr
          .split("\n")
          .filter((line) => line.startsWith("Native process proof diagnostic: "))
          .map((line) =>
            NativeProcessDiagnosticSchema.parse(
              JSON.parse(line.slice("Native process proof diagnostic: ".length)),
            ),
          );
        expect(events.some((event) => event.reason === reason)).toBe(true);
        for (const event of events)
          metrics.observeProof("fleet", { source: "native", checkpoint: "final", event });
        evidence.push({ deny, exit: 1, events });
      }
      expect(metrics.snapshot().totals.nativeDiagnostics).toEqual({
        process_census_unavailable: 1,
        fd_list_unavailable: 1,
        argv_unavailable: 1,
      });
      await writeFile(resolve(directory, "diagnostics.json"), JSON.stringify(evidence, null, 2));
      await writeFile(resolve(directory, "metrics.json"), JSON.stringify(metrics.snapshot(), null, 2));
    } finally {
      client.destroy();
      peer.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
  30_000,
);
