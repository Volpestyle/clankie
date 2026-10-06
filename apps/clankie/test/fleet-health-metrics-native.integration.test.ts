import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { createServer, createConnection, type Socket } from "node:net";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { FleetHealthMetrics } from "../src/fleet-health-metrics.ts";
import { localFleetProof, type LocalFleetProofOptions } from "../src/local-fleet-proof.ts";
import { fleetProcessHelper, observeSocketProcess, observeNativeBirth } from "../src/local-fleet-process.ts";
import { closeNativeProcessObservers } from "../src/native-process-transport.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const nativeIt = it.skipIf(process.platform !== "darwin" || process.env.FLEET_PROOF_NATIVE_TEST !== "1");
nativeIt(
  "counts real admissions and dependency/registry failures without diagnostic double counting",
  async () => {
    const logDirectory = resolve(".local/fleet-metrics", `native-${Date.now()}`);
    await mkdir(logDirectory, { recursive: true });
    const herdr = await isolatedHerdr(logDirectory);
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing actual TCP listener");
    const accepted = once(server, "connection");
    const client = createConnection(address.port, "127.0.0.1");
    await once(client, "connect");
    const [socket] = (await accepted) as [Socket];
    const metrics = new FleetHealthMetrics();
    const helper = fleetProcessHelper();
    const unavailableHelper = resolve(logDirectory, "missing-helper");
    const binding = { runtime: "external" as const, session: "default", socketPath: herdr.socketPath };
    let fault: "method" | "framing" = "method";
    const relaySockets = new Set<Socket>();
    const relay = createServer((peer) => {
      const upstream = createConnection(herdr.socketPath);
      relaySockets.add(peer);
      relaySockets.add(upstream);
      for (const stream of [peer, upstream]) {
        stream.on("error", () => {});
        stream.on("close", () => {
          relaySockets.delete(stream);
          peer.destroy();
          upstream.destroy();
        });
      }
      createInterface({ input: peer }).on("line", (line) => {
        const request = JSON.parse(line);
        if (fault === "method") request.method = "fixture.unknown_method";
        upstream.write(JSON.stringify(request) + "\n");
      });
      let first = true;
      upstream.on("data", (chunk: Buffer) => {
        // Corrupt the opening byte of an actual provider reply, rather than
        // inventing a provider or kernel response.
        peer.write(fault === "framing" && first ? chunk.subarray(1) : chunk);
        first = false;
      });
    });
    const relayPath = resolve(herdr.root, "fault-control.sock");
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(relayPath, resolve);
    });
    // A real same-user private transport registry, pinned to this actual socket's OS owner.
    const registry = new Set([process.pid]);
    const options: LocalFleetProofOptions = {
      binding: async () => binding,
      herdrBinary: "herdr",
      processHelper: helper,
      privateSeat: async (chain) => registry.has(chain[0]!),
      diagnostics: (event, pane) => metrics.observeProof("fleet", event, pane),
    };
    const proof = (overrides: Partial<LocalFleetProofOptions> = {}) =>
      localFleetProof({ ...options, ...overrides });
    let effects = 0;
    const request = async (candidate: ReturnType<typeof proof>, pane = herdr.pane) => {
      const accepted = await candidate(socket, pane);
      if (accepted) effects++;
      return accepted;
    };
    try {
      const admitted = proof();
      expect(await request(admitted)).toBe(true);
      expect(await request(admitted)).toBe(true);
      expect(await request(admitted, "invalid/pane")).toBe(false);
      expect(await request(proof({ platform: "unsupported" }))).toBe(false);
      expect(await request(admitted, "w999999:p999999")).toBe(false);
      expect(await proof({ privateSeat: async () => false })(socket, herdr.pane)).toBe(false);
      expect(await proof({ binding: async () => undefined })(socket, herdr.pane)).toBe(false);
      expect(await proof({ processHelper: unavailableHelper })(socket, herdr.pane)).toBe(false);
      let observations = 0;
      expect(
        await proof({
          observeSocket: (peer, expected) =>
            observeSocketProcess(peer, ++observations === 1 ? helper : unavailableHelper, expected),
        })(socket, herdr.pane),
      ).toBe(false);
      // A real parent exit changes the client's OS ancestry between the initial
      // and final census while the connected child keeps its birth and socket.
      const descendantHelper = resolve(logDirectory, "processes");
      await promisify(execFile)("cc", [
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-mmacosx-version-min=14.0",
        "apps/clankie/test/helpers/native-proof-churn/processes.c",
        "-o",
        descendantHelper,
      ]);
      const descendantConnection = once(server, "connection");
      const parent = spawn(descendantHelper, ["descendant", String(address.port)], { stdio: "pipe" });
      const parentExit = once(parent, "exit");
      const parentClosed = once(parent, "close");
      const reader = createInterface({ input: parent.stdout });
      const [line] = await once(reader, "line");
      reader.close();
      const match = /^ready (\d+) (\d+)$/u.exec(String(line));
      if (!match) throw new Error("Missing actual descendant socket");
      const descendantPid = Number(match[1]);
      const birth = await observeNativeBirth(descendantPid);
      const [descendantSocket] = (await descendantConnection) as [Socket];
      try {
        expect(
          await proof({
            privateSeat: async (chain) => {
              if (chain[0] !== descendantPid) return false;
              parent.stdin.end("q");
              await parentExit;
              return true;
            },
          })(descendantSocket, herdr.pane),
        ).toBe(false);
      } finally {
        if (birth && (await observeNativeBirth(descendantPid))?.join(".") === birth.join(".")) {
          try {
            process.kill(descendantPid, "SIGTERM");
          } catch {
            /* The owned child already exited. */
          }
        }
        descendantSocket.destroy();
        if (parent.exitCode === null) {
          parent.stdin.end("q");
          await parentExit;
        }
        await parentClosed;
      }
      let grants = 0;
      expect(
        await proof({
          privateSeat: async (chain) => {
            if (++grants > 1) registry.delete(process.pid);
            return registry.has(chain[0]!);
          },
        })(socket, herdr.pane),
      ).toBe(false);
      registry.add(process.pid);
      let linked = binding;
      expect(
        await proof({
          binding: async () => linked,
          privateSeat: async (chain) => {
            linked = { ...binding, session: "changed" };
            return registry.has(chain[0]!);
          },
        })(socket, herdr.pane),
      ).toBe(false);
      expect(
        await proof({
          binding: async () => ({ ...binding, socketPath: resolve(logDirectory, "missing-control.sock") }),
        })(socket, herdr.pane),
      ).toBe(false);
      for (const mode of ["method", "framing"] as const) {
        fault = mode;
        expect(await request(proof({ binding: async () => ({ ...binding, socketPath: relayPath }) }))).toBe(
          false,
        );
      }
      expect(
        await request(
          proof({
            privateSeat: async (chain) => {
              await herdr.cli("pane", "close", herdr.pane);
              return registry.has(chain[0]!);
            },
          }),
        ),
      ).toBe(false);
      const closed = once(socket, "close");
      socket.destroy();
      await closed;
      expect(await request(admitted)).toBe(false);
      expect(effects).toBe(2);
      const snapshot = metrics.snapshot();
      expect(snapshot.totals.proof).toEqual({
        attempts: 17,
        refusals: 15,
        byReason: {
          not_member: 1,
          missing_binding: 1,
          native_initial_unavailable: 1,
          native_final_unavailable: 1,
          private_seat_expired: 1,
          binding_changed: 1,
          observation_failed: 3,
          closed_socket: 1,
          snapshot_changed: 1,
          invalid_pane: 1,
          unsupported_platform: 1,
          pane_unavailable: 1,
          pane_changed: 1,
        },
      });
      expect(snapshot.totals.transportDiagnostics.helper_unavailable).toBe(1);
      expect(snapshot.windows[0].proofRefusalRate).toBe(15 / 17);
      expect(JSON.stringify(snapshot)).not.toContain(herdr.socketPath);
      expect(JSON.stringify(snapshot)).not.toMatch(/\bpid\b/u);
    } finally {
      for (const peer of relaySockets) peer.destroy();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      client.destroy();
      socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeNativeProcessObservers();
      await herdr.close();
    }
  },
);
