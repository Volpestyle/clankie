// Explicit manual benchmark: ten real shipped worker bridges and restored private-server records.
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
import * as proofCurrent from "../src/local-fleet-proof.ts";
import * as observerCurrent from "../src/project-process-proof.ts";
import * as registryCurrent from "../src/local-codex-seats.ts";
import { fleetProcessHelper } from "../src/local-fleet-process.ts";
import { closeNativeProcessObservers } from "../src/native-process-transport.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";
import { frequencyBaseline } from "./helpers/project-native-proof/frequency-baseline.ts";
import { frequencySpawns } from "./helpers/project-native-proof/frequency-spawns.ts";
import { peerSeatAuthority } from "../src/app/peer-seat-authority.ts";
import { PeerSeatMessages } from "../src/captain/peer-seat-messages.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";

const checkout = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures = fileURLToPath(new URL("./helpers/project-native-proof/", import.meta.url));
const exec = promisify(execFile);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
interface CpuSnapshot {
  pid: number;
  ppid: number;
  birth: [string, string];
  userNs: string;
  systemNs: string;
  childUserNs: string;
  childSystemNs: string;
}
interface BridgeReply {
  catalogReady: boolean;
  bridgePid?: number;
  harnessPid: number;
  tools?: string[];
}
const nativeIt = it.skipIf(process.platform !== "darwin" || process.env.PROJECT_PROOF_FREQUENCY_TEST !== "1");
const durationSeconds = Number(process.env.PROJECT_PROOF_FREQUENCY_SECONDS ?? 60);
const churnEnabled = process.env.PROJECT_PROOF_CHURN === "1";
const legacyPeers = process.env.PROJECT_PROOF_LEGACY_PEERS === "1";

nativeIt(
  "measures ten real worker bridges through restored native private-seat proof",
  async () => {
    const variant = process.env.PROJECT_PROOF_FREQUENCY_VARIANT ?? "current";
    if (!["current", "ae91cca8", "b5b24bdb", "a1ceae9d"].includes(variant))
      throw new Error("Unknown benchmark variant");
    if (!Number.isInteger(durationSeconds) || durationSeconds < 60 || durationSeconds > 300)
      throw new Error("Benchmark duration must be 60–300 seconds");
    if (legacyPeers && variant !== "current")
      throw new Error("Legacy peer benchmark requires current sources");
    const evidenceRoot =
      churnEnabled || variant === "a1ceae9d"
        ? ".local/project-proof/churn/benchmark"
        : ".local/project-proof/frequency";
    const logDirectory = join(checkout, evidenceRoot, `${variant}-${Date.now()}`);
    await mkdir(logDirectory, { recursive: true });
    const preserved = join(
      checkout,
      variant === "a1ceae9d" ? ".local/project-proof/churn/benchmark" : ".local/project-proof/frequency",
      `baseline-${variant}`,
    );
    const api =
      variant === "current"
        ? { ...proofCurrent, ...observerCurrent, ...registryCurrent }
        : await frequencyBaseline(checkout, variant as "ae91cca8" | "b5b24bdb" | "a1ceae9d");
    const helper =
      variant === "current"
        ? fleetProcessHelper(checkout)
        : variant === "a1ceae9d"
          ? join(preserved, ".local/fleet-proof/native-process-proof")
          : join(preserved, "native-process-proof");
    if (variant === "a1ceae9d") await mkdir(join(preserved, ".local/fleet-proof"), { recursive: true });
    if (variant !== "current")
      await exec("cc", [
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        join(
          preserved,
          variant === "a1ceae9d"
            ? "integrations/fleet-proof/native-process-proof.c"
            : "native-process-proof.c",
        ),
        "-o",
        helper,
      ]);
    const sampler = join(logDirectory, "cpu-snapshot");
    await exec("cc", ["-O2", "-Wall", "-Wextra", "-Werror", join(fixtures, "cpu-snapshot.c"), "-o", sampler]);
    const sample = async (pids: number[]) =>
      (await exec(sampler, pids.map(String))).stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as CpuSnapshot);
    const node = await realpath(process.execPath);
    const keeper = join(fixtures, "foreground-keeper.mjs");
    const bridgeScript = legacyPeers
      ? join(checkout, ".local/project-proof/legacy-worker/bin/fleet-mcp.mjs")
      : variant === "current"
        ? join(checkout, "integrations/claude-plugin/worker/bin/fleet-mcp.mjs")
        : join(
            preserved,
            variant === "a1ceae9d"
              ? "integrations/claude-plugin/worker/bin/fleet-mcp.mjs"
              : "worker/bin/fleet-mcp.mjs",
          );
    const herdr = await isolatedHerdr(logDirectory);
    const tracker = frequencySpawns();
    const children: ChildProcess[] = [];
    const sockets = new Set<Socket>();
    const roster: {
      name: string;
      pane: string;
      thread: string;
      foregroundPid: number;
      parentPid: number;
      bridgePid?: number;
    }[] = [];
    const trace: unknown[] = [];
    const requests: {
      started: number;
      ended?: number;
      pane: string;
      path: string;
      method?: string;
      status?: number;
      reason?: string;
    }[] = [];
    const counts = { fleet: 0, fleetAdmitted: 0, project: 0, restoredOccupant: 0, privateRegistry: 0 };
    let linked = true;
    let phase = "setup";
    let local: LocalFleetLink | undefined;
    let listener: ReturnType<typeof serve> | undefined;
    let worker: WorkerMcp | undefined;
    let host: ReturnType<typeof createMcpHost> | undefined;
    const eventStops = new Set<() => void>();
    const binding = { runtime: "external" as const, socketPath: herdr.socketPath, session: "default" };
    let summary: unknown;
    let churn: ChildProcess | undefined;
    let churnClosed: Promise<unknown> | undefined;
    const churnEvents: unknown[] = [];
    try {
      const observe = api.createProjectProcessObserver({
        binding: async () => (linked ? binding : undefined),
        herdrBinary: "herdr",
        processHelper: helper,
        launcher: async () => ({ executable: node, script: keeper }),
      });
      const durable = {
        path: join(herdr.root, "seats.json"),
        observeOccupant: async (pane: string) => {
          counts.restoredOccupant++;
          const proof = await observe("default", pane);
          return proof?.nativeSessionPending ? undefined : proof?.nativeOccupantId;
        },
      };
      let registry = new api.LocalCodexSeats(() => (linked ? binding : undefined), undefined, durable);
      for (let index = 0; index < 10; index++) {
        const pane =
          index === 0
            ? herdr.pane
            : index === 1
              ? herdr.foreignPane
              : ((await herdr.cli("workspace", "create", "--cwd", herdr.root, "--no-focus")).result.root_pane
                  .pane_id as string);
        const name = `bridge-${index}`;
        const thread = randomUUID();
        await herdr.cli(
          "pane",
          "run",
          pane,
          [node, keeper, herdr.controlPath, `keeper-${index}`, pane, herdr.socketPath, thread]
            .map(quote)
            .join(" "),
        );
        const foregroundPid = await herdr.waitForClient(`keeper-${index}`);
        const observed = await observe("default", pane);
        trace.push({ phase: "preflight", pane, observed, agent: await herdr.cli("agent", "get", pane) });
        expect(observed?.nativeSessionPending).toBeUndefined();
        expect(observed?.nativeOccupantId).toBeDefined();
        const parent = spawn(
          node,
          [
            join(fixtures, "bridge-harness.mjs"),
            herdr.controlPath,
            bridgeScript,
            herdr.root,
            name,
            pane,
            herdr.socketPath,
            join(logDirectory, `${name}.jsonl`),
          ],
          { env: { ...process.env }, stdio: "ignore" },
        );
        children.push(parent);
        const parentPid = await herdr.waitForClient(name);
        expect(parentPid).toBe(parent.pid);
        await registry.register(parentPid, pane).bindSession?.(thread);
        roster.push({ name, pane, thread, foregroundPid, parentPid });
      }
      const stored = JSON.parse(await readFile(durable.path, "utf8"));
      expect(stored.seats).toHaveLength(10);
      await writeFile(join(logDirectory, "restored-records.json"), JSON.stringify(stored, null, 2) + "\n");
      for (const entry of stored.seats) {
        expect((await observe("default", entry.pane))?.nativeOccupantId).toBe(entry.nativeOccupantId);
      }
      // Reconstruct from the actual durable controller record: every entry is restored:true.
      registry = new api.LocalCodexSeats(() => (linked ? binding : undefined), undefined, durable);
      const options: proofCurrent.LocalFleetProofOptions = {
        herdrBinary: "herdr",
        processHelper: helper,
        binding: async () => (linked ? binding : undefined),
        launcher: async () => ({ executable: node, script: keeper }),
        privateSeat: async (ancestors, pane, current) => {
          counts.privateRegistry++;
          return registry.allows(ancestors, pane, current);
        },
        privateProjectSeat: async (ancestors, pane, current, proof) =>
          registry.allows(ancestors, pane, current, proof.nativeOccupantId),
        diagnostics: (event) => trace.push({ at: performance.now(), phase, diagnostic: event }),
      };
      const prove = api.localFleetProof(options);
      const project = api.localProjectProof(options);
      const credentials = new FileCredentialStore(join(herdr.root, "empty-credentials.json"));
      const settings = new SettingsStore(join(herdr.root, "settings.json"));
      await settings.update((value) => ({
        ...value,
        fleet: { ...value.fleet, tools: "connected", peerMessages: legacyPeers ? "on" : "off" },
        mcp: { ...value.mcp, servers: [] },
      }));
      host = createMcpHost({ settings, credentials, curated: [], logger: { info() {}, warn() {} } });
      worker = new WorkerMcp({
        directory: join(herdr.root, "grants"),
        credentials,
        host,
        fleetTools: async () => (await settings.load()).fleet.tools,
        fleetPeerMessages: async () => (await settings.load()).fleet.peerMessages,
      });
      local = new LocalFleetLink({
        directory: join(herdr.root, "links"),
        binding: options.binding,
        prove: async (socket, pane) => {
          counts.fleet++;
          const admitted = await prove(socket, pane);
          if (admitted) counts.fleetAdmitted++;
          return admitted;
        },
        projectProof: async (socket, pane) => {
          counts.project++;
          return project(socket, pane);
        },
      });
      const runner = createHerdrWatchRunner(
        undefined,
        async (args) => JSON.stringify(await herdr.cli(...args)),
        undefined,
        { localReadBinding: async () => binding },
      );
      const peers = new PeerSeatMessages({
        path: join(herdr.root, "peer-receipts.json"),
        enabled: async () => (await settings.load()).fleet.peerMessages === "on",
        sender: (pane) => runner.get(pane),
        recipient: (seat) => runner.resolveTerminal(seat),
        seats: () => runner.list!(),
        deliver: async () => {
          throw new Error("Benchmark never sends peer messages");
        },
        record: () => {
          throw new Error("Benchmark never records peer messages");
        },
      });
      const boundary = local.fetch(async (request) => {
        const identity = local!.identity(request);
        if (!identity) return Response.json({ error: "missing_identity" }, { status: 403 });
        const url = new URL(request.url);
        if (url.pathname === "/v1/fleet/mcp") return worker!.handleLocalFleet(request, identity);
        if (legacyPeers && url.pathname.endsWith("/peers")) {
          const authority = await peerSeatAuthority(identity, identity.pane);
          if (!authority) return Response.json({ error: "native_peer_sender_required" }, { status: 403 });
          const seats = await peers.list(authority);
          return seats
            ? Response.json(seats)
            : Response.json({ error: "peer_messaging_unavailable" }, { status: 403 });
        }
        // Same extra local validation as registerSeatRoutes.fleetSeatPane; only an empty in-memory mailbox is supplied.
        if (!(await identity.validate()))
          return Response.json({ error: "local_pane_required" }, { status: 403 });
        if (url.pathname.endsWith("/events")) {
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              request.signal.removeEventListener("abort", finish);
              eventStops.delete(finish);
              resolve();
            };
            const timer = setTimeout(finish, Math.min(25_000, Number(url.searchParams.get("wait") ?? 0)));
            eventStops.add(finish);
            request.signal.addEventListener("abort", finish, { once: true });
          });
          return Response.json({ schemaVersion: 1, events: [] });
        }
        if (url.pathname.endsWith("/peers"))
          return Response.json({ error: "peer_messages_disabled" }, { status: 403 });
        return Response.json({ error: "effects_disabled" }, { status: 405 });
      });
      listener = serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request, env) => {
          sockets.add(env.incoming.socket);
          const entry: (typeof requests)[number] = {
            started: performance.now(),
            pane: request.headers.get("x-clankie-pane") ?? "",
            path: new URL(request.url).pathname,
          };
          if (request.method === "POST")
            entry.method = (
              await request
                .clone()
                .json()
                .catch(() => ({}))
            )?.method;
          requests.push(entry);
          const response = await boundary(request, env);
          entry.ended = performance.now();
          entry.status = response.status;
          if (!response.ok)
            entry.reason = (
              await response
                .clone()
                .json()
                .catch(() => ({}))
            )?.error;
          return response;
        },
      });
      if (!listener.listening) await once(listener, "listening");
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("Missing listener");
      await local.publish(address.port);
      phase = "startup";
      for (const bridge of roster) await herdr.request(bridge.name, bridge.pane, "share");
      const ready = async () =>
        Promise.all(
          roster.map(async (bridge) => {
            const status = (await herdr.request(bridge.name, bridge.pane)) as unknown as BridgeReply;
            if (status.bridgePid) bridge.bridgePid = status.bridgePid;
            return { name: bridge.name, ...status };
          }),
        );
      let startup = await ready();
      const deadline = Date.now() + 35_000;
      while (startup.some((status) => !status.catalogReady) && Date.now() < deadline) {
        await delay(500);
        startup = await ready();
      }
      trace.push({ phase, startup });
      expect(startup.every((status) => !!status.bridgePid)).toBe(true);
      expect(startup.every((status) => status.catalogReady)).toBe(true);
      if (churnEnabled) {
        churn = spawn(node, [join(fixtures, "process-churn.mjs"), join(logDirectory, "churn.json")], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        churnClosed = once(churn, "close");
        const lines = createInterface({ input: churn.stdout! });
        const next = () =>
          new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Churn fixture readiness timeout")), 3_000);
            lines.once("line", (line) => {
              clearTimeout(timer);
              churnEvents.push(JSON.parse(line));
              resolve();
            });
            churn!.once("error", reject);
          });
        await next();
        const started = next();
        churn.stdin!.write(JSON.stringify({ durationMs: (durationSeconds + 15) * 1_000 }) + "\n");
        await started;
      }
      const shellSample = (await sample([herdr.shellPid]))[0]!;
      const daemonPid = shellSample.ppid;
      const samplePids = [
        process.pid,
        daemonPid,
        ...roster.map((entry) => entry.bridgePid!),
        ...[...tracker.persistent].map((child) => child.pid!).filter(Boolean),
        ...(churn?.pid ? [churn.pid] : []),
      ];
      const cpuBefore = await sample(samplePids);
      const beforeCounts = { ...counts };
      const bodyBefore = process.cpuUsage();
      const started = performance.now();
      const startedEpochMs = Date.now();
      phase = "measuring";
      await writeFile(
        join(logDirectory, "MEASURING.json"),
        JSON.stringify({ variant, startedEpochMs, durationSeconds, churnPid: churn?.pid }) + "\n",
      );
      console.log(`MEASUREMENT START ${variant} ${startedEpochMs} ${logDirectory}`);
      await delay(durationSeconds * 1_000);
      const ended = performance.now();
      const endedEpochMs = Date.now();
      const bodyCpu = process.cpuUsage(bodyBefore);
      phase = "endpoint";
      const cpuAfter = await sample(samplePids);
      if (churn) {
        churn.stdin!.end(JSON.stringify({ stop: true }) + "\n");
        await churnClosed;
      }
      console.log(`MEASUREMENT END ${variant} ${endedEpochMs} ${logDirectory}`);
      const afterCounts = { ...counts };
      const live = await ready();
      const spawns = tracker.records.filter((record) => record.at >= started && record.at < ended);
      const intervalRequests = requests.filter(
        (record) => record.started >= started && record.started < ended,
      );
      summary = {
        variant,
        legacyPeers,
        churnEnabled,
        churnPid: churn?.pid,
        churnEvents,
        startedEpochMs,
        endedEpochMs,
        started,
        ended,
        seconds: (ended - started) / 1000,
        bodyCpu,
        cpuBefore,
        cpuAfter,
        beforeCounts,
        afterCounts,
        startup,
        live,
        spawnDispatches: spawns.length,
        successfulSpawns: spawns.filter((record) => record.started).length,
        spawnsPerSecond: spawns.filter((record) => record.started).length / ((ended - started) / 1000),
        intervalRequests,
        allRequests: requests,
        roster,
        effects: 0,
        coverage:
          "10 ordinary foreground fixtures +10 restored private parents spawning shipped fleet-mcp bridges; no installed TUI or provider; real empty McpHost; in-memory empty event mailbox; legacy-peer mode uses production peer authority and PeerSeatMessages through native Herdr reads",
      };
      expect(live.every((status) => !!status.bridgePid)).toBe(true);
      expect(live.every((status) => status.catalogReady)).toBe(true);
      if (legacyPeers) {
        for (const status of [...startup, ...live]) {
          expect(status.tools).toContain("list_fleet_seats");
          expect(status.tools).toContain("message_peer");
        }
        expect(
          intervalRequests.some((request) => request.path.endsWith("/peers") && request.status === 200),
        ).toBe(true);
      }
      expect(afterCounts.privateRegistry - beforeCounts.privateRegistry).toBeGreaterThan(0);
      expect(afterCounts.restoredOccupant - beforeCounts.restoredOccupant).toBeGreaterThan(0);
      expect(intervalRequests.length).toBeGreaterThan(0);
      for (const bridge of roster) {
        expect(
          intervalRequests.some((request) => request.pane === bridge.pane && request.status === 200),
        ).toBe(true);
      }
      for (let index = 0; index < cpuBefore.length; index++) {
        expect(cpuAfter[index]?.birth).toEqual(cpuBefore[index]?.birth);
      }
    } finally {
      phase = "cleanup";
      if (churn && churn.exitCode === null && churn.signalCode === null) {
        churn.stdin?.end(JSON.stringify({ stop: true }) + "\n");
        await churnClosed;
      }
      linked = false;
      await local?.close();
      for (const stop of eventStops) stop();
      for (const socket of sockets) socket.destroy();
      if (listener) await new Promise<void>((resolve) => listener!.close(() => resolve()));
      await worker?.close();
      await host?.close();
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
      await herdr.close();
      await closeNativeProcessObservers();
      if ("closeNativeProcessObservers" in api) await api.closeNativeProcessObservers?.();
      tracker.close();
      await writeFile(
        join(logDirectory, "evidence.json"),
        JSON.stringify({ summary, counts, requests, trace, spawns: tracker.records }, null, 2) + "\n",
      );
      console.log(`Frequency benchmark evidence: ${logDirectory}`);
    }
  },
  durationSeconds * 1_000 + 120_000,
);
