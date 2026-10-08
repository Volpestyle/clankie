import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { FleetHealthMetrics } from "../src/fleet-health-metrics.ts";
import { NativeProcessDiagnosticSchema } from "../src/local-fleet-process.ts";

const run = promisify(execFile);
const manual = process.platform === "darwin" && process.env.FLEET_ALLOCATION_TEST === "1";

it.skipIf(!manual)(
  "counts real ENOMEM from the stock Intel allocator on an owned TCP proof",
  async () => {
    const directory = resolve(".local/allocation-os", String(Date.now()));
    await mkdir(directory, { recursive: true });
    const executable = resolve(directory, "allocation-space");
    await run("cc", [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-arch",
      "x86_64",
      "apps/clankie/test/helpers/native-proof-churn/allocation-space.c",
      "-lproc",
      "-o",
      executable,
    ]);
    const server = createServer().listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing owned listener");
    const connecting = once(server, "connection");
    const client = createConnection(address.port, "127.0.0.1");
    let peer: Socket | undefined;
    const options = {
      timeout: 7000,
      env: {
        ...process.env,
        MallocNanoZone: "0",
        MallocMediumZone: "0",
        MallocSecureAllocator: "0",
        MallocGuardEdges: "1",
      },
    };
    try {
      [peer] = (await connecting) as [Socket];
      const ports = [String(client.localPort), String(address.port)];
      const baseline = await run(executable, [...ports, "baseline"], options);
      expect(JSON.parse(baseline.stdout).schemaVersion).toBe(1);
      const reply = await run(executable, ports, options).catch(
        (error: { code: number; stdout: string; stderr: string }) => {
          expect(error.code).toBe(1);
          return error;
        },
      );
      expect(reply.stdout).toBe("");
      const events = reply.stderr
        .split("\n")
        .filter((line) => line.startsWith("Native process proof diagnostic: "))
        .map((line) => NativeProcessDiagnosticSchema.parse(JSON.parse(line.slice(33))));
      expect(events.filter((event) => event.reason === "allocation_failed")).toEqual([
        {
          schemaVersion: 1,
          stage: "fd_list",
          reason: "allocation_failed",
          errno: 12,
          attempt: 1,
          retry: false,
        },
      ]);
      const metrics = new FleetHealthMetrics();
      for (const event of events)
        metrics.observeProof("fleet", { source: "native", checkpoint: "initial", event });
      const snapshot = metrics.snapshot();
      expect(snapshot.totals.nativeDiagnostics.allocation_failed).toBe(1);
      expect(snapshot.totals.proof.attempts).toBe(0);
      for (const window of snapshot.windows) expect(window.nativeDiagnostics.allocation_failed).toBe(1);
      await writeFile(
        resolve(directory, "evidence.json"),
        JSON.stringify(
          {
            baselineProof: true,
            architecture: "x86_64",
            refused: reply.stdout === "",
            events,
            metrics: snapshot,
          },
          null,
          2,
        ),
      );
    } finally {
      client.destroy();
      peer?.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
  30_000,
);
