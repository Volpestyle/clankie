// Manual real-kernel integration. Only scheduling is controlled; PID/FD/socket
// data, process births, Herdr replies and HTTP admission use real dependencies.
import { serve } from "@hono/node-server";
import { execFile } from "node:child_process";
import { once } from "node:events";
import type { Server as HttpServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
import { localFleetProof, type LocalFleetProofDiagnostic } from "../src/local-fleet-proof.ts";
import { closeNativeProcessObservers } from "../src/native-process-transport.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const nativeIt = it.skipIf(process.platform !== "darwin" || process.env.FLEET_PROOF_NATIVE_TEST !== "1");
const exec = promisify(execFile);

nativeIt(
  "refuses a surviving socket inheritor when a previously observed socket sharer exits",
  async () => {
    const directory = resolve(".local/admission-churn", "shared-handoff");
    await mkdir(directory, { recursive: true });
    const helper = join(directory, "scheduled-handoff");
    await exec("cc", [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-mmacosx-version-min=14.0",
      "-lproc",
      ...(process.env.FLEET_PROOF_BASELINE_SOURCE
        ? [`-DFLEET_PROOF_SOURCE=${JSON.stringify(process.env.FLEET_PROOF_BASELINE_SOURCE)}`]
        : []),
      "apps/clankie/test/helpers/native-proof-churn/scheduled.c",
      "-o",
      helper,
    ]);
    const result = await exec(helper, ["--shared-handoff"], { timeout: 1_000 }).then(
      (reply) => ({ ...reply, code: 0 }),
      (error: Error & { code: number; stdout: string; stderr: string }) => error,
    );
    const kernel = JSON.parse(await readFile(`${helper}.handoff.kernel.jsonl`, "utf8"));
    // These are actual observations before owned child cleanup. The vanished
    // co-owner is not the risk: its new, unlisted successor still holds the FD.
    expect(kernel).toMatchObject({ handoff: true, successorLive: true, successorOwnsSocket: true });
    await writeFile(join(directory, "evidence.json"), JSON.stringify({ kernel, result }, null, 2) + "\n");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"reason":"process_changed"');
    expect(result.stderr).toContain('"reason":"multiple_owners"');
  },
  10_000,
);

nativeIt.each(["census", "fd", "exit"])(
  "admits a real pane client within the existing budget during scheduled %s churn",
  async (mode) => {
    const directory = resolve(".local/admission-churn", mode);
    await mkdir(directory, { recursive: true });
    const helper = join(directory, `scheduled-${mode}`);
    await exec("cc", [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-mmacosx-version-min=14.0",
      "-lproc",
      ...(process.env.FLEET_PROOF_BASELINE_SOURCE
        ? [`-DFLEET_PROOF_SOURCE=${JSON.stringify(process.env.FLEET_PROOF_BASELINE_SOURCE)}`]
        : []),
      "apps/clankie/test/helpers/native-proof-churn/scheduled.c",
      "-o",
      helper,
    ]);
    await rm(`${helper}.kernel.jsonl`, { force: true });
    const herdr = await isolatedHerdr(directory);
    const binding = { runtime: "external" as const, socketPath: herdr.socketPath, session: "default" };
    const diagnostics: LocalFleetProofDiagnostic[] = [];
    const measurements: unknown[] = [];
    let effects = 0;
    const proof = localFleetProof({
      binding: async () => binding,
      herdrBinary: "herdr",
      processHelper: helper,
      diagnostics: (event) => diagnostics.push(event),
    });
    const link = new LocalFleetLink({
      directory: join(herdr.root, "links"),
      binding: async () => binding,
      prove: proof,
    });
    const forward = link.fetch(() => {
      effects++;
      return Response.json({ admitted: true });
    });
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request, env) => {
        const started = performance.now();
        const response = await forward(request, env);
        return Response.json(
          {
            ...(await response.json()),
            effects,
            elapsedMs: performance.now() - started,
            port: env.incoming.socket.remotePort,
          },
          { status: response.status },
        );
      },
    });
    try {
      if (!server.listening) await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing real HTTP listener");
      const endpoint = `http://127.0.0.1:${address.port}`;
      if (mode === "census" && !process.env.FLEET_PROOF_BASELINE_SOURCE) {
        const sharedCensus = await exec(helper, ["--shared-census"], { timeout: 1_000 }).then(
          () => {
            throw new Error("New shared owner was admitted");
          },
          (error: Error & { code: number; stdout: string; stderr: string }) => error,
        );
        expect(sharedCensus.code).toBe(1);
        expect(sharedCensus.stdout).toBe("");
        expect(sharedCensus.stderr).toContain('"reason":"process_census_changed"');
        expect(sharedCensus.stderr).toContain('"reason":"multiple_owners"');
        measurements.push({ phase: "shared-owner-born-between-lists", stderr: sharedCensus.stderr });
      }
      await herdr.startClient("member", endpoint, true);
      const admitted = await herdr.request("member");
      measurements.push({ phase: "member", ...admitted });
      expect(admitted.status).toBe(200);
      expect(admitted.elapsedMs).toBeLessThan(2_000); // two 600 ms proofs plus real Herdr control
      expect(admitted.effects).toBe(1);
      const nativeEvents = diagnostics.flatMap((event) => (event.source === "native" ? [event] : []));
      if (mode === "exit") {
        const observations = (await readFile(`${helper}.kernel.jsonl`, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(observations).toHaveLength(2); // actual ESRCH at both socket-proof checkpoints
        expect(observations.every((event) => event.fd_list_bytes <= 0 && event.fd_list_errno === 3)).toBe(
          true,
        );
        measurements.push({ phase: "confirmed-exit-between-bsd-and-fd", observations });
      } else
        for (const checkpoint of ["initial", "final"] as const) {
          expect(nativeEvents).toContainEqual(
            expect.objectContaining({
              checkpoint,
              event: expect.objectContaining({
                reason: mode === "census" ? "process_census_changed" : "socket_unavailable",
              }),
            }),
          );
        }
      if (mode === "fd") {
        expect(
          nativeEvents.some(
            ({ event }) =>
              event.reason === "socket_unavailable" && [3, 9].includes(event.errno) && event.retry,
          ),
        ).toBe(true); // real Darwin ESRCH/EBADF
      }
      expect(nativeEvents.every(({ event }) => event.attempt === 1)).toBe(true);
      expect(
        nativeEvents.some(({ event }) => ["attempts_exhausted", "budget_exhausted"].includes(event.reason)),
      ).toBe(false);

      const repeated = await herdr.request("member");
      measurements.push({ phase: "same-connection", ...repeated });
      expect(repeated.status).toBe(200);
      expect(repeated.port).toBe(admitted.port);
      expect(repeated.elapsedMs).toBeLessThan(2_000);
      expect(repeated.effects).toBe(2);

      const wrongPane = await herdr.request("member", herdr.foreignPane);
      measurements.push({ phase: "wrong-pane", ...wrongPane });
      expect(wrongPane.status).toBe(403);
      expect(wrongPane.effects).toBe(2);
      await herdr.startClient("outsider", endpoint, false);
      const outsider = await herdr.request("outsider");
      measurements.push({ phase: "outsider", ...outsider });
      expect(outsider.status).toBe(403);
      expect(outsider.effects).toBe(2);
      expect(diagnostics).toContainEqual({ source: "proof", reason: "not_member" });

      await herdr.request("member", herdr.pane, "share");
      const shared = await herdr.request("member");
      measurements.push({ phase: "shared-owner", ...shared });
      expect(shared.status).toBe(403);
      expect(shared.effects).toBe(2);
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          source: "native",
          event: expect.objectContaining({ reason: "multiple_owners" }),
        }),
      );
      await herdr.request("member", herdr.pane, "release");
      const recovery = await herdr.request("member");
      measurements.push({ phase: "recovery", ...recovery });
      expect(recovery.status).toBe(200);
      expect(recovery.effects).toBe(3);
    } finally {
      await writeFile(
        join(directory, "evidence.json"),
        JSON.stringify({ mode, measurements, diagnostics }, null, 2) + "\n",
      );
      await link.close();
      (server as HttpServer).closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await closeNativeProcessObservers();
      await herdr.close();
    }
  },
  30_000,
);
