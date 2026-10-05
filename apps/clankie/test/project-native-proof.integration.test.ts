// Manual macOS integration. Real kernel/Herdr/TCP; trusted fixture launcher, not an installed Codex TUI.
import { serve } from "@hono/node-server";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, copyFile, realpath, readFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
import { localFleetProof, localProjectProof, type LocalFleetProofOptions } from "../src/local-fleet-proof.ts";
import {
  fleetProcessHelper,
  observeSocketProcess,
  observeNativeProcesses,
  type NativeSocketOwner,
} from "../src/local-fleet-process.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";
import { countProofSpawns, type SpawnRecord } from "./helpers/project-native-proof/spawns.ts";
import { baselineProof } from "./helpers/project-native-proof/baseline.ts";
import { closeNativeProcessObservers } from "../src/native-process-transport.ts";

const checkout = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures = fileURLToPath(new URL("./helpers/project-native-proof/", import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const nativeIt = it.skipIf(process.platform !== "darwin" || process.env.PROJECT_NATIVE_PROOF_TEST !== "1");

nativeIt(
  "proves project access at the real socket boundary and counts actual spawn dispatches",
  async () => {
    const baseline = process.env.PROJECT_NATIVE_BASELINE === "1";
    const logDirectory = join(
      checkout,
      ".local/project-proof",
      `${baseline ? "before" : "after"}-${Date.now()}`,
    );
    await mkdir(logDirectory, { recursive: true });
    const proofModule = baseline ? await baselineProof(checkout) : { localProjectProof };
    const helper = fleetProcessHelper(checkout);
    const node = await realpath(process.execPath);
    const herdr = await isolatedHerdr(logDirectory);
    const harness = join(fixtures, "harness.mjs");
    const client = join(fixtures, "client.mjs");
    let trustedScript = harness;
    let linked = true;
    let missingHelper = false;
    let expected: NativeSocketOwner | undefined;
    let effects = 0;
    let phase = "cold";
    const trace: unknown[] = [];
    const snapshots = new Map<number, NativeSocketOwner>();
    const sockets = new Map<number, Socket>();
    const children: ChildProcess[] = [];
    const counter = countProofSpawns();
    const binding = { runtime: "external" as const, socketPath: herdr.socketPath, session: "default" };
    let cleanupLink: LocalFleetLink | undefined;
    let cleanupServer: ReturnType<typeof serve> | undefined;
    const measurements: {
      phase: string;
      admitted: boolean;
      elapsedMs: number;
      records: SpawnRecord[];
    }[] = [];
    try {
      const options: LocalFleetProofOptions = {
        herdrBinary: "herdr",
        processHelper: helper,
        binding: async () => (linked ? binding : undefined),
        launcher: async () => ({ executable: node, script: trustedScript }),
        expectedOwner: () => expected,
        diagnostics: (event) => trace.push({ phase, diagnostic: event }),
        ...(baseline
          ? {
              run: async (command: string, args: string[], env?: NodeJS.ProcessEnv) => {
                const result = await promisify(execFile)(command, args, {
                  env,
                  timeout: 5_000,
                  maxBuffer: 2_000_000,
                });
                trace.push({ phase, command, args, stdout: result.stdout });
                return result.stdout;
              },
            }
          : {}),
      };
      const proof = proofModule.localProjectProof(options);
      const unavailable = localProjectProof({
        ...options,
        processHelper: join(logDirectory, "missing-helper"),
      });
      const link = new LocalFleetLink({
        directory: join(herdr.root, "links"),
        binding: options.binding,
        prove: localFleetProof(options),
        projectProof: async (socket, pane) => {
          const measurement = await counter.measure(() =>
            (missingHelper ? unavailable : proof)(socket, pane),
          );
          measurements.push({
            phase,
            admitted: !!measurement.value,
            elapsedMs: measurement.elapsedMs,
            records: measurement.records,
          });
          return measurement.value;
        },
      });
      cleanupLink = link;
      const forward = link.fetch(async (request) => {
        const project = await link.identity(request)?.projectProof?.();
        if (!project) return Response.json({ refused: true }, { status: 403 });
        effects++;
        return Response.json({ admitted: true });
      });
      const server = serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request, env) => {
          const socket = env.incoming.socket;
          const port = socket.remotePort!;
          sockets.set(port, socket);
          const response = await forward(request, env);
          if (!snapshots.has(port)) {
            const snapshot = await observeSocketProcess(socket, helper);
            if (snapshot) snapshots.set(port, snapshot.owner);
          }
          return Response.json({ ...(await response.json()), effects, port }, { status: response.status });
        },
      });
      cleanupServer = server;
      if (!server.listening) await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing real TCP listener");
      const endpoint = `http://127.0.0.1:${address.port}/v1/fleet/mcp`;
      const launch = async (name: string, script = harness, shell = false, emptyArgv = false) => {
        const args = [herdr.controlPath, client, name, endpoint, herdr.pane, herdr.socketPath, randomUUID()];
        const command = shell
          ? ["/bin/sh", join(fixtures, "shell.sh"), ...args, node]
          : emptyArgv
            ? [join(herdr.root, "exec-argv"), node, "argv0", script, ...args]
            : [node, script, ...args, "TAIL_ARG_SENTINEL_DO_NOT_EMIT"];
        await herdr.cli(
          "pane",
          "run",
          herdr.pane,
          ["env", "PROJECT_FIXTURE_SENTINEL=ENV_SENTINEL_DO_NOT_EMIT", ...command].map(quote).join(" "),
        );
        const pid = await herdr.waitForClient(name);
        const info = await herdr.cli("pane", "process-info", "--pane", herdr.pane);
        return { pid, agentPid: info.result.process_info.foreground_process_group_id as number };
      };
      const stop = async (name: string, processes: { pid: number; agentPid: number }) => {
        await herdr.quitClient(name);
        await herdr.waitForExit(processes.pid);
        await herdr.waitForExit(processes.agentPid);
        trace.push({ phase, exited: processes, kernelAbsence: "ESRCH" });
      };
      const ask = async (name: string, status: number, pane = herdr.pane) => {
        const before = effects;
        // This fixture's action is a harmless counter. Only a classified fresh-census
        // refusal BEFORE forwarding can sample again; wrong identity/protocol never retries.
        for (let sample = 1; sample <= 8; sample++) {
          const checkpoint = trace.length;
          const result = await herdr.request(name, pane);
          trace.push({ phase, sample, ...result });
          if (result.status === status) {
            expect(effects).toBe(before + (status === 200 ? 1 : 0));
            return result;
          }
          const nativeFailure = trace.slice(checkpoint).some((entry) => {
            const diagnostic = (entry as { diagnostic?: { source?: string; event?: { reason?: string } } })
              .diagnostic;
            return diagnostic?.source === "native" && diagnostic.event?.reason === "attempts_exhausted";
          });
          expect(result.status, `${phase}: see ${logDirectory}`).toBe(403);
          expect(effects).toBe(before);
          if (status !== 200 || !nativeFailure || sample === 8)
            throw new Error(`${phase}: see ${logDirectory}; unavailable without a completed proof`);
          await new Promise((resolve) => setTimeout(resolve, 75));
        }
        throw new Error("No real response");
      };
      if (!baseline) {
        await herdr.cli(
          "pane",
          "run",
          herdr.pane,
          [node, client, herdr.controlPath, "unrelated-job", endpoint, herdr.pane].map(quote).join(" ") +
            " &",
        );
        await herdr.waitForClient("unrelated-job");
      }
      const first = await launch("first");
      const accepted = await ask("first", 200);
      phase = "warm";
      await ask("first", 200);
      if (baseline) {
        await writeFile(
          join(checkout, ".local/project-proof/baseline-counts.json"),
          JSON.stringify(
            { source: "b5533700", logDirectory, counts: measurements.map((item) => item.records.length) },
            null,
            2,
          ),
        );
        return;
      }
      const baselineCounts = await readFile(
        join(checkout, ".local/project-proof/baseline-counts.json"),
        "utf8",
      )
        .then((value) => JSON.parse(value) as { counts: number[] })
        .catch(() => undefined);
      if (baselineCounts)
        expect(Math.min(...baselineCounts.counts)).toBeGreaterThan(measurements[0]!.records.length);
      const cold = measurements[0]!;
      expect(cold.records.length).toBeGreaterThan(0);
      expect(cold.records.every((record) => record.started)).toBe(true);
      expect(cold.records.map((record) => record.kind)).toEqual(["native:serve"]);
      expect(
        measurements
          .filter((measurement) => measurement.phase === "warm")
          .flatMap((measurement) => measurement.records),
      ).toEqual([]);
      expect(
        measurements.flatMap((item) => item.records).some((record) => /^(ps|lsof)$/u.test(record.command)),
      ).toBe(false);
      // Separate census checkpoints from every owned proof child. Capturing
      // overlaps in both directions also detects a Herdr child started after
      // an already-running census, rather than only census-start overlap.
      expect(
        measurements
          .flatMap((item) => item.records)
          .every((record) =>
            record.kind === "native:socket"
              ? record.overlappingKinds.length === 0
              : !record.overlappingKinds.includes("native:socket"),
          ),
      ).toBe(true);
      const original = snapshots.get(accepted.port)!;
      expect(original.pid).toBe(first.pid);
      phase = "helper-exit-fresh-proof";
      const helperPid = cold.records[0]!.pid!;
      process.kill(helperPid, "SIGKILL");
      await herdr.waitForExit(helperPid);
      await ask("first", 200);
      expect(
        measurements
          .filter((measurement) => measurement.phase === phase)
          .flatMap((measurement) => measurement.records)
          .filter((record) => record.started),
      ).toHaveLength(1);
      const native = await observeNativeProcesses(herdr.shellPid, first.agentPid, helper);
      expect(native?.processes[1]?.argv).toEqual([node, harness]);
      expect(JSON.stringify(native)).not.toContain("TAIL_ARG_SENTINEL_DO_NOT_EMIT");
      trace.push({ phase: "native-argv", native });
      expect(JSON.stringify(native)).not.toContain("ENV_SENTINEL_DO_NOT_EMIT");
      phase = "unrelated-pane-job";
      await ask("unrelated-job", 403);
      phase = "foreign-pane";
      await ask("first", 403, herdr.foreignPane);
      phase = "binding-revoked";
      linked = false;
      await ask("first", 403);
      linked = true;
      phase = "missing-helper";
      missingHelper = true;
      await ask("first", 403);
      missingHelper = false;
      const outsider = spawn(node, [client, herdr.controlPath, "outsider", endpoint, herdr.pane], {
        stdio: "ignore",
      });
      children.push(outsider);
      await herdr.waitForClient("outsider");
      phase = "outsider";
      const outside = await ask("outsider", 403);
      const otherBirth = snapshots.get(outside.port)!.birth;
      expect(otherBirth).not.toEqual(original.birth);
      phase = "same-live-owner-stale-birth";
      expected = { ...original, birth: otherBirth };
      trace.push({ phase, actual: original, expected });
      await ask("first", 403);
      expected = undefined;
      expect(sockets.get(accepted.port)?.destroyed).toBe(false);
      phase = "original-exit";
      await stop("first", first);
      expect(sockets.get(accepted.port)?.destroyed).toBe(true);
      phase = "replacement";
      const replacement = await launch("replacement");
      const fresh = await ask("replacement", 200);
      const freshOwner = snapshots.get(fresh.port)!;
      expect(freshOwner.pid).not.toBe(original.pid);
      expect(freshOwner.birth).not.toEqual(original.birth);
      expect(fresh.port).not.toBe(accepted.port);
      phase = "replacement-stale-birth";
      expected = { ...freshOwner, birth: original.birth };
      trace.push({ phase, actual: freshOwner, expected });
      await ask("replacement", 403);
      expected = undefined;
      phase = "replacement-fresh-proof";
      await ask("replacement", 200);
      await stop("replacement", replacement);
      phase = "wrong-script";
      const otherScript = join(herdr.root, "other.mjs");
      await copyFile(harness, otherScript);
      const wrong = await launch("wrong", otherScript);
      await ask("wrong", 403);
      await stop("wrong", wrong);
      phase = "shell-launcher";
      const shell = await launch("shell", harness, true);
      await ask("shell", 403);
      await stop("shell", shell);
      phase = "exact-script-argv-boundaries";
      trustedScript = join(herdr.root, "trusted 中文 ' line\nscript.mjs");
      await copyFile(harness, trustedScript);
      trustedScript = await realpath(trustedScript);
      const spaced = await launch("spaced", trustedScript);
      await ask("spaced", 200);
      const spacedNative = await observeNativeProcesses(herdr.shellPid, spaced.agentPid, helper);
      expect(spacedNative?.processes[1]?.argv).toEqual([node, trustedScript]);
      expect(JSON.stringify(spacedNative)).not.toContain("TAIL_ARG_SENTINEL_DO_NOT_EMIT");
      trace.push({ phase, native: spacedNative });
      await stop("spaced", spaced);
      phase = "empty-argv-zero";
      await promisify(execFile)("cc", [
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        join(fixtures, "exec-argv.c"),
        "-o",
        join(herdr.root, "exec-argv"),
      ]);
      const empty = await launch("empty", trustedScript, false, true);
      const emptyNative = await observeNativeProcesses(herdr.shellPid, empty.agentPid, helper);
      expect(emptyNative?.processes[1]?.argv).toEqual(["", trustedScript]);
      await ask("empty", 403);
      trace.push({ phase, native: emptyNative });
      await stop("empty", empty);
      expect(
        measurements.flatMap((item) => item.records).some((record) => /^(ps|lsof)$/u.test(record.command)),
      ).toBe(false);
    } finally {
      try {
        await writeFile(
          join(logDirectory, "evidence.json"),
          JSON.stringify({ baseline, measurements, trace, socketOwners: [...snapshots.values()] }, null, 2) +
            "\n",
        );
      } finally {
        counter.close();
        await closeNativeProcessObservers();
        await cleanupLink?.close();
        for (const socket of sockets.values()) socket.destroy();
        if (cleanupServer) await new Promise<void>((resolve) => cleanupServer!.close(() => resolve()));
        for (const child of children) if (child.exitCode === null) child.kill();
        await herdr.close();
        console.log(`Project native proof evidence: ${logDirectory}`);
      }
    }
  },
  90_000,
);
