// Manual native integration: owns an isolated Herdr daemon, never a live seat.
import { Server as HttpServer } from "node:http";
import { serve } from "@hono/node-server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Socket } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
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
    const logDirectory = join(checkout, ".local/proof-cost", `lifetime-${Date.now()}`);
    const helper = fleetProcessHelper(checkout);
    await mkdir(logDirectory, { recursive: true });
    const herdr = await isolatedHerdr(logDirectory);
    let linked = true;
    const legacyScans: string[] = [];
    const trace: unknown[] = [];
    let phase = "cold";
    let cpuLoad: { done(): Promise<void> } | undefined;
    let expected: NativeSocketOwner | undefined;
    const binding = { runtime: "external" as const, socketPath: herdr.socketPath, session: "default" };
    const prove = localFleetProof({
      herdrBinary: "herdr",
      processHelper: helper,
      binding: async () => (linked ? binding : undefined),
      expectedOwner: () => expected,
      diagnostics: (event) => trace.push({ phase, diagnostic: event }),
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
    const ancestorSnapshots = new Map<number, readonly { pid: number; birth: readonly [string, string] }[]>();
    const measurements = new WeakMap<Socket, number>();
    let effects = 0;
    const link = new LocalFleetLink({
      directory: join(herdr.root, "links"),
      binding: async () => (linked ? binding : undefined),
      prove: async (socket, pane) => {
        const start = performance.now();
        const admitted = await prove(socket, pane);
        const elapsedMs = performance.now() - start;
        measurements.set(socket, elapsedMs);
        trace.push({ phase, admitted, elapsedMs, port: socket.remotePort });
        return admitted;
      },
    });
    const forward = link.fetch(() => {
      effects++;
      return Response.json({ forwarded: true });
    });
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request, env) => {
        try {
          const socket = env.incoming.socket;
          const port = socket.remotePort!;
          sockets.set(port, socket);
          const response = await forward(request, env);
          // Observe only after admission/refusal and outside proof timing. This
          // never substitutes for LocalFleetLink's real socket-boundary check.
          if (!snapshots.has(port)) {
            const snapshot = await observeSocketProcess(socket, helper);
            if (snapshot) {
              snapshots.set(port, snapshot.owner);
              ancestorSnapshots.set(port, snapshot.ancestors);
            } else {
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
          return Response.json(
            {
              ...(await response.json()),
              elapsedMs: measurements.get(socket),
              port,
              effects,
            },
            { status: response.status },
          );
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 });
        }
      },
    });
    try {
      await new Promise<void>((resolve) =>
        server.listening ? resolve() : server.once("listening", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing listener port");
      const endpoint = `http://127.0.0.1:${address.port}`;
      const memberPid = await herdr.startClient("member", endpoint, true);
      let loginAncestor:
        | { pid: number; ppid: number; uid: number; euid: number; command: string }
        | undefined;
      if (process.env.FLEET_PROOF_LOGIN_TEST === "1") {
        const ancestry = [];
        let pid = memberPid;
        while (pid > 1 && ancestry.length < 64) {
          // Evidence only, outside proof timing and outside its command runner.
          // No argv/environment is read; these are actual kernel process IDs.
          const { stdout } = await promisify(execFile)(
            "/bin/ps",
            ["-p", String(pid), "-o", "pid=,ppid=,ruid=,uid=,comm="],
            { timeout: 1_000 },
          );
          const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(stdout);
          if (!match) throw new Error(`Missing native ancestor ${pid}`);
          const row = {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            uid: Number(match[3]),
            euid: Number(match[4]),
            command: match[5]!,
          };
          ancestry.push(row);
          if (row.euid === 0 && /(?:^|\/)login$/u.test(row.command)) loginAncestor = row;
          if (row.ppid === pid) throw new Error("Native process ancestry cycle");
          pid = row.ppid;
        }
        await writeFile(
          join(logDirectory, "login-ancestry.json"),
          JSON.stringify({ memberPid, loginAncestor, ancestry }, null, 2) + "\n",
        );
        expect(
          loginAncestor,
          "Run this flag through actual same-user /usr/bin/login in an owned PTY",
        ).toBeDefined();
        expect(loginAncestor!.euid).not.toBe(process.getuid?.());
      }
      if (process.env.FLEET_PROOF_CPU_LOAD === "1") cpuLoad = await herdr.startCpuLoad();
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
      if (loginAncestor) {
        const nativeAncestor = ancestorSnapshots.get(cold.port)?.find(({ pid }) => pid === loginAncestor.pid);
        expect(nativeAncestor).toBeDefined();
        expect(Number(nativeAncestor!.birth[0])).toBeGreaterThan(0);
        await writeFile(
          join(logDirectory, "login-kernel-birth.json"),
          JSON.stringify({ loginAncestor, nativeAncestor }, null, 2) + "\n",
        );
      }
      const warm = [];
      const warmResults = [];
      for (let index = 0; index < 20; index++) {
        phase = `warm-${index + 1}`;
        const response = await herdr.request("member");
        // Retain every distinct request and defer assertions so an unrelated
        // census refusal cannot erase the independent lifetime evidence below.
        // No request is retried or counted twice.
        warmResults.push(response);
        warm.push(response.elapsedMs);
      }
      const sorted = [...warm].sort((a, b) => a - b);
      const timing = {
        coldMs: cold.elapsedMs,
        warmMs: warm,
        warmResults,
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
        maxMs: sorted.at(-1)!,
        memberPid,
        shellPid: herdr.shellPid,
      };
      await writeFile(join(logDirectory, "timing.json"), JSON.stringify(timing, null, 2) + "\n");
      console.log(JSON.stringify({ nativeFleetProof: timing, logDirectory }));
      phase = "fd-churn";
      const stableOwner = await observeSocketProcess(sockets.get(cold.port)!, helper);
      expect(stableOwner?.owner).toEqual(snapshots.get(cold.port));
      const churnEffectsBefore = effects;
      const diagnosticsStart = trace.length;
      const churn = await herdr.startFdChurn();
      let churnResponse;
      try {
        churnResponse = await herdr.request("member");
        expect(churnResponse.status).toBe(403);
        expect(churnResponse.error).toBe("local_process_membership_required");
        expect(churnResponse.port).toBe(cold.port);
        expect(churnResponse.effects).toBe(churnEffectsBefore);
        expect(effects).toBe(churnEffectsBefore);
      } finally {
        await churn.stop();
      }
      const churnDiagnostics = trace.slice(diagnosticsStart);
      expect(
        churnDiagnostics.some((entry) => {
          const row = entry as {
            diagnostic?: { source?: string; event?: { stage?: string; reason?: string; errno?: number } };
          };
          return (
            row.diagnostic?.source === "native" &&
            row.diagnostic.event?.stage === "fd_socket" &&
            row.diagnostic.event.reason === "socket_unavailable" &&
            [9, 38].includes(row.diagnostic.event.errno!)
          );
        }),
      ).toBe(true);
      phase = "fd-churn-recovery";
      const afterChurnOwner = await observeSocketProcess(sockets.get(cold.port)!, helper);
      expect(afterChurnOwner?.owner).toEqual(stableOwner!.owner);
      const recovered = await herdr.request("member");
      expect(recovered.status).toBe(200);
      expect(recovered.port).toBe(cold.port);
      expect(recovered.effects).toBe(churnEffectsBefore + 1);
      await writeFile(
        join(logDirectory, "fd-churn.json"),
        JSON.stringify(
          {
            churnPid: churn.pid,
            beforeOwner: stableOwner!.owner,
            churnResponse,
            effectsBefore: churnEffectsBefore,
            churnDiagnostics,
            afterOwner: afterChurnOwner!.owner,
            recovered,
          },
          null,
          2,
        ) + "\n",
      );
      phase = "shared-owner";
      const shared = await herdr.request("member", herdr.pane, "share");
      expect(shared.coOwnerPid).toBeGreaterThan(1);
      expect(shared.coOwnerPid).not.toBe(memberPid);
      expect((await herdr.request("member")).status).toBe(403);
      phase = "shared-owner-released";
      await herdr.request("member", herdr.pane, "release");
      expect((await herdr.request("member")).status).toBe(200);
      phase = "foreign-pane";
      expect((await herdr.request("member", herdr.foreignPane)).status).toBe(403);
      phase = "unknown-pane";
      expect((await herdr.request("member", "w0:p0")).status).toBe(403);
      phase = "outsider";
      const outsiderPid = await herdr.startClient("outsider", endpoint, false);
      const outsider = await herdr.request("outsider");
      expect(outsider.status).toBe(403);
      expect(snapshots.get(outsider.port)?.pid).toBe(outsiderPid);

      phase = "binding-revoked";
      linked = false;
      expect((await herdr.request("member")).status).toBe(403);
      phase = "binding-restored";
      linked = true;
      expect((await herdr.request("member")).status).toBe(200);

      phase = "lifetime";
      const memberOwner = snapshots.get(cold.port)!;
      const outsiderOwner = snapshots.get(outsider.port)!;
      const liveOwner = await observeSocketProcess(sockets.get(cold.port)!, helper);
      expect(liveOwner?.owner).toEqual(memberOwner);
      expect(() => process.kill(memberPid, 0)).not.toThrow();
      expect(memberOwner.birth).not.toEqual(outsiderOwner.birth);
      // Controlled PID-reuse boundary: same actual owner PID/socket, a stale birth
      // captured from another real process. The live kernel observer stays real.
      // This does not claim the OS recycled a numeric PID during this test.
      expected = { ...memberOwner, birth: outsiderOwner.birth };
      const effectsBefore = effects;
      const stale = await herdr.request("member");
      expect(stale.status).toBe(403);
      expect(stale.error).toBe("local_process_membership_required");
      expect(stale.port).toBe(cold.port);
      expect(stale.effects).toBe(effectsBefore);
      expect(effects).toBe(effectsBefore);
      expect(sockets.get(cold.port)!.destroyed).toBe(false);
      const staleExpected = expected;
      expected = undefined;
      await herdr.quitClient("member");
      const exit = await herdr.waitForExit(memberPid);
      const closed = sockets.get(cold.port)!;
      await waitClosed(closed);
      expect(await prove(closed, herdr.pane)).toBe(false);
      phase = "replacement";
      const replacementPid = await herdr.startClient("replacement", endpoint, true);
      expect(replacementPid).not.toBe(memberPid);
      const replacement = await herdr.request("replacement");
      expect(replacement.status).toBe(200);
      expect(replacement.port).not.toBe(cold.port);
      const replacementOwner = snapshots.get(replacement.port)!;
      expect(replacementOwner.pid).toBe(replacementPid);
      expect(replacementOwner.birth).not.toEqual(memberOwner.birth);
      expect(replacementOwner.socket).not.toBe(memberOwner.socket);
      expect(replacement.effects).toBe(effectsBefore + 1);
      await writeFile(
        join(logDirectory, "lifetime.json"),
        JSON.stringify(
          {
            oldOwner: memberOwner,
            staleExpected,
            stale,
            effectsBefore,
            effectsAfterRefusal: stale.effects,
            exit,
            replacementOwner,
            replacement,
          },
          null,
          2,
        ) + "\n",
      );
      phase = "pane-closed";
      await herdr.cli("pane", "close", herdr.pane);
      const removedPaneSocket = sockets.get(replacement.port)!;
      await waitClosed(removedPaneSocket);
      expect(await prove(removedPaneSocket, herdr.pane)).toBe(false);
      expect((await herdr.request("outsider", herdr.pane)).status).toBe(403);

      // Startup/compilation are not included. These bounds catch the prior 4–9 s
      // proof scans while requiring a materially smaller per-request budget.
      expect(warmResults.map(({ status }) => status)).toEqual(Array(20).fill(200));
      expect(warmResults.every(({ port }) => port === cold.port)).toBe(true);
      expect(legacyScans).toEqual([]);
      expect(timing.p95Ms).toBeLessThan(100);
      expect(timing.maxMs).toBeLessThan(250);
    } finally {
      try {
        await cpuLoad?.done();
        await writeFile(join(logDirectory, "requests.json"), JSON.stringify(trace, null, 2) + "\n");
      } finally {
        await link.close();
        if (server instanceof HttpServer) server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await herdr.close();
      }
    }
  },
  30_000,
);
