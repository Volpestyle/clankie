// Manual real-kernel/Herdr/Unix-WS recovery. The copied Node fixture is NOT a Codex TUI.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, copyFile, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { recoverLocalCodexSession } from "../src/captain/herdr-census.ts";
import { LocalCodexSeats } from "../src/local-codex-seats.ts";
import { readLocalCodexRecords } from "../src/local-codex-records.ts";
import { nativeProcessReceipt, observeNativeBirth, observeCodexServer } from "../src/local-fleet-process.ts";
import { closeNativeProcessObservers } from "../src/native-process-transport.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";
import { frequencySpawns } from "./helpers/project-native-proof/frequency-spawns.ts";

const checkout = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = fileURLToPath(
  new URL("./helpers/native-process-transport/codex-recovery-fixture.mjs", import.meta.url),
);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const nativeIt = it.skipIf(process.platform !== "darwin" || process.env.FLEET_PROOF_NATIVE_TEST !== "1");

nativeIt(
  "recovers real unreported foreground and owned Unix server from micro/legacy records, refusing stale authority",
  async () => {
    const logs = join(checkout, ".local/project-proof", `native-recovery-${Date.now()}`);
    const herdr = await isolatedHerdr(logs);
    let server: ChildProcess | undefined;
    let stderr = "";
    const evidence: unknown[] = [];
    let counter: ReturnType<typeof frequencySpawns> | undefined;
    try {
      const node = await realpath(process.execPath);
      const codex = join(herdr.root, "bin", "codex");
      await mkdir(dirname(codex));
      // Preserve Homebrew Node's @executable_path/../lib layout without changing Mach-O bytes.
      await symlink(join(dirname(node), "../lib"), join(herdr.root, "lib"));
      await copyFile(node, codex);
      await chmod(codex, 0o700);
      const nativeSocket = join(await realpath(herdr.root), "native.sock");
      const alias = join(herdr.root, "alias.sock");
      const endpoint = `unix://${alias}`;
      const thread = randomUUID();
      const statePath = join(herdr.root, "server.json");
      const journal = join(logs, "server-rpc.jsonl");
      const setThread = (value: string) =>
        writeFile(statePath, JSON.stringify({ thread: value, nativeSocket, journal }));
      await setThread(thread);
      server = spawn(
        codex,
        [fixture, "server", statePath, "unused", "unused", "unused", "app-server", "--listen", endpoint],
        {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      server.stderr!.on("data", (bytes) => {
        stderr += String(bytes);
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Server readiness timeout: ${stderr}`)), 3_000);
        server!.once("error", reject);
        server!.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Server exited ${code}: ${stderr}`));
        });
        server!.stdout!.once("data", (bytes) => {
          clearTimeout(timer);
          try {
            expect(JSON.parse(String(bytes))).toEqual({ ready: true, pid: server!.pid });
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
      await symlink(nativeSocket, alias);
      await herdr.cli(
        "pane",
        "run",
        herdr.pane,
        [
          codex,
          fixture,
          "foreground",
          statePath,
          herdr.controlPath,
          herdr.pane,
          herdr.socketPath,
          "--remote",
          endpoint,
          "resume",
          thread,
        ]
          .map(quote)
          .join(" "),
      );
      const foregroundPid = await herdr.waitForClient("recovery-foreground");
      const agent = (await herdr.cli("agent", "get", herdr.pane)).result.agent;
      expect(agent.agent).toBe("codex");
      expect(agent.agent_session).toBeUndefined();
      const info = (await herdr.cli("pane", "process-info", "--pane", herdr.pane)).result.process_info;
      expect(info.foreground_process_group_id).toBe(foregroundPid);
      evidence.push({ foregroundPid, serverPid: server.pid, info, agent });
      const binding = { runtime: "external" as const, socketPath: herdr.socketPath, session: "default" };
      const recordsPath = join(herdr.root, "seats.json");
      const registry = new LocalCodexSeats(() => binding, undefined, {
        path: recordsPath,
        // Registration never invokes this restored-admission callback.
        observeOccupant: async () => {
          throw new Error("Unexpected restored registry admission");
        },
      });
      const registration = registry.register(server.pid!, herdr.pane);
      await registration.bindSession!(thread, endpoint);
      const records = readLocalCodexRecords(recordsPath);
      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.start).toMatch(/^\d+\.\d{6}$/u);
      const birth = await observeNativeBirth(server.pid!);
      expect(birth).toBeDefined();
      expect(await observeCodexServer(server.pid!, endpoint, await realpath(alias))).toEqual(birth);
      const entry = { paneId: herdr.pane, agent: "codex" };
      const options = {
        localCodexRecordsPath: recordsPath,
        bridgeSocket: herdr.socketPath,
        herdrSession: "default",
      };
      const expected = { source: "herdr:codex", kind: "id", value: thread };
      const save = (start: string) =>
        writeFile(recordsPath, JSON.stringify({ version: 1, seats: [{ ...record, start }] }));
      counter = frequencySpawns();
      const check = async (phase: string, allowed: boolean) => {
        const result = await recoverLocalCodexSession(entry, options);
        evidence.push({ phase, result: result ?? null });
        expect(result, phase).toEqual(allowed ? expected : undefined);
      };
      await check("microbirth", true);
      const english = nativeProcessReceipt(birth!, "Mon Jan  1 00:00:00 2001");
      expect(english).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) /u);
      await save(english);
      await check("legacy-english-same-native-birth", true);
      await save(`${BigInt(birth![0]) + 1n}.${birth![1].padStart(6, "0")}`);
      process.kill(server.pid!, 0);
      await check("wrong-microbirth-live-server", false);
      await save(record.start);
      await setThread(randomUUID());
      await check("different-loaded-thread", false);
      await setThread(thread);
      await check("restored-loaded-thread", true);
      const duplicate = await herdr.request("recovery-foreground", herdr.pane, "share");
      expect(duplicate.coOwnerPid).toBeGreaterThan(1);
      process.kill(duplicate.coOwnerPid!, 0);
      evidence.push({ duplicateForegroundPid: duplicate.coOwnerPid });
      await check("ambiguous-live-foreground", false);
      await herdr.request("recovery-foreground", herdr.pane, "release");
      await herdr.waitForExit(duplicate.coOwnerPid!);
      await check("unique-foreground-restored", true);
      registration();
      expect(readLocalCodexRecords(recordsPath)).toEqual([]);
      await check("revoked-durable-record", false);
      expect(counter.records).toEqual([]);
      const rpc = (await readFile(journal, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rpc.some(({ method }) => method === "initialize")).toBe(true);
      expect(rpc.filter(({ method }) => method === "thread/loaded/list")).toHaveLength(5);
      evidence.push({ actualSpawnDispatches: counter.records, rpc });
    } finally {
      counter?.close();
      await closeNativeProcessObservers();
      if (server && server.exitCode === null && server.signalCode === null) {
        const closed = once(server, "close");
        server.kill("SIGTERM");
        await closed;
      }
      await herdr.close();
      await mkdir(logs, { recursive: true });
      await writeFile(join(logs, "evidence.json"), JSON.stringify({ evidence, stderr }, null, 2) + "\n");
    }
  },
  20_000,
);
