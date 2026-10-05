// Manual native integration: owns an isolated Herdr daemon, never a live seat.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Socket } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";
import { localFleetProof } from "../src/local-fleet-proof.ts";
import {
  fleetProcessHelper,
  observeSocketProcess,
  type NativeSocketOwner,
} from "../src/local-fleet-process.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const nativeIt = it.skipIf(process.platform !== "darwin" || process.env.FLEET_PROOF_NATIVE_TEST !== "1");
const checkout = fileURLToPath(new URL("../../../", import.meta.url));
const waitClosed = (socket: Socket) =>
  new Promise<void>((resolve, reject) => {
    if (socket.destroyed) return resolve();
    const timer = setTimeout(() => reject(new Error("Owned client socket did not close")), 2_000);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });

nativeIt(
  "proves live pane ancestry over real TCP, rejects stale process birth, and stays bounded",
  async () => {
    const logDirectory = join(checkout, ".local/proof-cost", `integration-${Date.now()}`);
    const helper = fleetProcessHelper(checkout);
    await mkdir(logDirectory, { recursive: true });
    const herdr = await isolatedHerdr(logDirectory);
    let linked = true;
    const legacyScans: string[] = [];
    const trace: unknown[] = [];
    let expected: NativeSocketOwner | undefined;
    const binding = { runtime: "external" as const, socketPath: herdr.socketPath, session: "default" };
    const prove = localFleetProof({
      herdrBinary: "herdr",
      processHelper: helper,
      binding: async () => (linked ? binding : undefined),
      expectedOwner: () => expected,
      // Deny old scan commands, while running every real Herdr command. No
      // fabricated process output or admission decision enters this guard.
      run: async (command, args, env) => {
        if (command === "/usr/sbin/lsof" || (command === "/bin/ps" && args.includes("-axo"))) {
          legacyScans.push(command);
          throw new Error("Legacy process scan reached the native proof hot path");
        }
        const result = await promisify(execFile)(command, args, { env, timeout: 5_000 });
        return result.stdout;
      },
    });
    const sockets = new Map<number, Socket>();
    const snapshots = new Map<number, NativeSocketOwner>();
    const server = createServer(async (request, response) => {
      try {
        const socket = request.socket;
        const port = socket.remotePort!;
        sockets.set(port, socket);
        const start = performance.now();
        const admitted = await prove(socket, String(request.headers["x-clankie-pane"] ?? ""));
        const elapsedMs = performance.now() - start;
        trace.push({ admitted, elapsedMs, port });
        // Capture genuine native identities after the first proof so the cold
        // measurement is not warmed by a diagnostic observer. This
        // observation does not grant admission and is never a replacement observer.
        if (!snapshots.has(port)) {
          const snapshot = await observeSocketProcess(socket, helper);
          if (snapshot) snapshots.set(port, snapshot.owner);
          else {
            const diagnostic = await promisify(execFile)(helper, [String(port), String(socket.localPort)], {
              timeout: 1_000,
            })
              .then(({ stdout, stderr }) => ({ stdout, stderr }))
              .catch((error: Error & { stderr?: string; code?: string | number }) => ({
                message: error.message,
                stderr: error.stderr,
                code: error.code,
              }));
            await writeFile(
              join(logDirectory, `native-refusal-${port}.json`),
              JSON.stringify(diagnostic, null, 2) + "\n",
            );
          }
        }
        response.writeHead(admitted ? 200 : 403, { "content-type": "application/json" });
        response.end(JSON.stringify({ elapsedMs, port }));
      } catch (error) {
        response.writeHead(500);
        response.end(JSON.stringify({ error: String(error) }));
      }
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing listener port");
      const endpoint = `http://127.0.0.1:${address.port}`;
      const memberPid = await herdr.startClient("member", endpoint, true);
      const cold = await herdr.request("member");
      await writeFile(
        join(logDirectory, "cold.json"),
        JSON.stringify(
          { cold, owner: snapshots.get(cold.port), memberPid, shellPid: herdr.shellPid },
          null,
          2,
        ) + "\n",
      );
      expect(cold.status).toBe(200);
      expect(snapshots.get(cold.port)?.pid).toBe(memberPid);
      const warm = [];
      for (let index = 0; index < 20; index++) {
        const response = await herdr.request("member");
        expect(response.status, `Warm proof ${index + 1}: ${JSON.stringify(response)}`).toBe(200);
        expect(response.port).toBe(cold.port);
        warm.push(response.elapsedMs);
      }
      const sorted = [...warm].sort((a, b) => a - b);
      const timing = {
        coldMs: cold.elapsedMs,
        warmMs: warm,
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
        maxMs: sorted.at(-1)!,
        memberPid,
        shellPid: herdr.shellPid,
      };
      await writeFile(join(logDirectory, "timing.json"), JSON.stringify(timing, null, 2) + "\n");
      console.log(JSON.stringify({ nativeFleetProof: timing, logDirectory }));
      const shared = await herdr.request("member", herdr.pane, "share");
      expect(shared.coOwnerPid).toBeGreaterThan(1);
      expect(shared.coOwnerPid).not.toBe(memberPid);
      expect((await herdr.request("member")).status).toBe(403);
      await herdr.request("member", herdr.pane, "release");
      expect((await herdr.request("member")).status).toBe(200);
      expect((await herdr.request("member", herdr.foreignPane)).status).toBe(403);
      expect((await herdr.request("member", "w0:p0")).status).toBe(403);
      const outsiderPid = await herdr.startClient("outsider", endpoint, false);
      const outsider = await herdr.request("outsider");
      expect(outsider.status).toBe(403);
      expect(snapshots.get(outsider.port)?.pid).toBe(outsiderPid);

      linked = false;
      expect((await herdr.request("member")).status).toBe(403);
      linked = true;
      expect((await herdr.request("member")).status).toBe(200);

      const memberOwner = snapshots.get(cold.port)!;
      const outsiderOwner = snapshots.get(outsider.port)!;
      expect(memberOwner.birth).not.toEqual(outsiderOwner.birth);
      // Controlled PID-reuse boundary: same actual owner PID/socket, a stale birth
      // captured from another real process. The live kernel observer stays real.
      // This does not claim the OS recycled a numeric PID during this test.
      expected = { ...memberOwner, birth: outsiderOwner.birth };
      expect((await herdr.request("member")).status).toBe(403);
      expected = undefined;
      await herdr.quitClient("member");
      const closed = sockets.get(cold.port)!;
      await waitClosed(closed);
      expect(await prove(closed, herdr.pane)).toBe(false);
      await herdr.startClient("replacement", endpoint, true);
      const replacement = await herdr.request("replacement");
      expect(replacement.status).toBe(200);
      expect(replacement.port).not.toBe(cold.port);
      await herdr.cli("pane", "close", herdr.pane);
      const removedPaneSocket = sockets.get(replacement.port)!;
      await waitClosed(removedPaneSocket);
      expect(await prove(removedPaneSocket, herdr.pane)).toBe(false);
      expect((await herdr.request("outsider", herdr.pane)).status).toBe(403);

      // Startup/compilation are not included. These bounds catch the prior 4–9 s
      // proof scans while requiring a materially smaller per-request budget.
      expect(legacyScans).toEqual([]);
      expect(timing.p95Ms).toBeLessThan(100);
      expect(timing.maxMs).toBeLessThan(250);
    } finally {
      await writeFile(join(logDirectory, "requests.json"), JSON.stringify(trace, null, 2) + "\n");
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await herdr.close();
    }
  },
  30_000,
);
