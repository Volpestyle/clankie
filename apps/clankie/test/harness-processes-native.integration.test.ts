// Manual native integration: real owned Herdr + installed Codex app-server.
// No provider turn or live worker is launched. Journal facts are fixture inputs.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { text } from "node:stream/consumers";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { runHeadlessCaptainCommand } from "../../tui/bin/headless-captain.ts";
import { runAgentsCommand } from "../../tui/src/command/agents.ts";
import { ClankieSettingsSchema } from "@clankie/settings";
import { join } from "node:path";
import { expect, it } from "vitest";
import { processIdentity } from "@clankie/fleet-resources";
import { FleetHarnessProcesses } from "../src/fleet-harness-processes.ts";
import { CodexAppServerClient, openCodexSocket } from "../src/captain/codex-app-server.ts";
import { LocalCodexSeats } from "../src/local-codex-seats.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

it
  .skipIf(process.platform !== "darwin" || process.env.NATIVE_HARNESS_RETIREMENT !== "1")
  .each(["original", "independent"] as const)(
  "real Codex %s scope: operator listing and exact closed-hire retirement guards",
  async (mode) => {
    const root = await realpath(await mkdtemp("/tmp/harness-retire-"));
    const herdr = await isolatedHerdr(join(root, "logs"));
    const stateRoot = join(root, "state"),
      stateDir = join(stateRoot, "captain");
    const binding = { runtime: "external" as const, session: "default", socketPath: herdr.socketPath };
    const endpoint = `unix://${join(root, "codex.sock")}`;
    const codexHome = join(root, "codex");
    await mkdir(codexHome);
    await mkdir(stateDir, { recursive: true });
    let child: ChildProcess | undefined, client: CodexAppServerClient | undefined;
    let http: Server | undefined, service: Awaited<ReturnType<typeof createClankieApp>> | undefined;
    const subject = new FleetHarnessProcesses({ stateRoot, binding: () => binding });
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
      delete env.HERDR_PANE_ID;
      delete env.HERDR_SOCKET_PATH;
      child = spawn("codex", ["app-server", "--listen", endpoint], { env, cwd: root, stdio: "ignore" });
      const pid = child.pid!;
      const registration = new LocalCodexSeats(
        () => binding,
        async (pid) => (await processIdentity(pid))?.startTime,
        {
          path: join(stateRoot, "local-codex-seats.json"),
          observeOccupant: async () => undefined,
        },
      ).register(pid, herdr.pane);
      let socket;
      for (let n = 0; n < 100 && !socket; n++) {
        socket = await openCodexSocket(`ws+unix://${endpoint.slice(7)}:/`);
        if (!socket) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!socket) throw new Error("Owned native Codex server did not listen");
      client = new CodexAppServerClient(socket, () => {}, 2_000);
      await client.initialize(true);
      const started = (await client.request("thread/start", {
        cwd: root,
        approvalPolicy: "never",
        sandbox: "read-only",
        persistExtendedHistory: true,
      })) as { thread: { id: string } };
      const threadId = started.thread.id;
      await registration.bindSession?.(threadId, endpoint);
      const occupantId = occupantIdForHerdrSession({ source: "herdr:codex", kind: "id", value: threadId });
      const owner = { conversationId: "owned-retirement-fixture" };
      const seatId = (await herdr.cli("pane", "process-info", "--pane", herdr.pane)).result.process_info
        .terminal_id;
      const paneList = (await herdr.cli("pane", "list")).result.panes as {
        pane_id: string;
        terminal_id: string;
      }[];
      const originalSeat = seatId ?? paneList.find((row) => row.pane_id === herdr.pane)!.terminal_id;
      const hires = new HireOwners(join(stateDir, "herdr-watches.json.owners.json"));
      hires.bind(
        herdr.pane,
        owner,
        originalSeat,
        undefined,
        occupantId,
        JSON.stringify(["local", "codex", threadId]),
      );
      const closed = {
        id: randomUUID(),
        paneId: herdr.pane,
        seatId: originalSeat,
        title: "Owned native fixture",
        harness: "codex",
        sessionId: threadId,
        workingDirectory: root,
        owner,
        closedBy: owner,
        reason: "Fixture complete",
        lastOutput: "Kept",
        reportPath: join(root, "report.md"),
        closedAt: new Date().toISOString(),
        undoUntil: new Date(Date.now() + 300_000).toISOString(),
        state: "closed",
      };
      const journal = (state = "closed") =>
        writeFile(
          join(stateDir, "pane-tidy.json"),
          JSON.stringify({ version: 1, entries: [{ ...closed, state }], reports: [] }),
        );
      await journal();
      // A prior closed journal cannot authorize signalling a currently live pane.
      service = await createClankieApp({
        captain: createStubCaptain({
          harnessProcesses: (retire) => (retire ? subject.retire() : subject.list()),
        }),
        settings: { load: async () => ClankieSettingsSchema.parse({ schemaVersion: 1 }) },
        eventLogPath: join(root, "events.jsonl"),
        authenticateOperator: async (request) =>
          request.headers.get("authorization") === "Bearer fixture-operator"
            ? { operatorId: "fixture" }
            : undefined,
      });
      http = createServer(async (request, response) => {
        try {
          const body = await text(request);
          const result = await service!.app.request(request.url!, {
            method: request.method ?? "GET",
            headers: {
              authorization: request.headers.authorization ?? "",
              "content-type": "application/json",
            },
            ...(request.method === "POST" ? { body } : {}),
          });
          response.writeHead(result.status, { "content-type": "application/json" });
          response.end(await result.text());
        } catch {
          response.writeHead(500);
          response.end();
        }
      });
      await new Promise<void>((resolve) => http!.listen(0, "127.0.0.1", resolve));
      const address = http.address();
      if (!address || typeof address === "string") throw new Error("No owned HTTP address");
      const host = `http://127.0.0.1:${address.port}`;
      const cliOptions = {
        env: { CLANKIE_OPERATOR_TOKEN: "fixture-operator", CLANKIE_CONTROL_PLANE_URL: host },
      };
      expect((await fetch(`${host}/v1/fleet/processes`)).status).toBe(401);
      expect(
        (
          await fetch(`${host}/v1/fleet/processes/retire`, {
            method: "POST",
            headers: { authorization: "Bearer fixture-operator", "content-type": "application/json" },
            body: JSON.stringify({ pid }),
          })
        ).status,
      ).toBe(400);
      const cliList = (await runAgentsCommand(["processes"], cliOptions)) as {
        processes: { pid: number; eligibility: string }[];
      };
      expect(cliList.processes.find((row) => row.pid === pid)?.eligibility).toBe("live");
      let fleetOutput = "";
      expect(
        await runHeadlessCaptainCommand(["fleet", "processes"], {
          ...cliOptions,
          repoRoot: root,
          stdout: {
            write: (value) => {
              fleetOutput += String(value);
            },
          },
        }),
      ).toBe(0);
      expect(
        JSON.parse(fleetOutput).processes.find((row: { pid: number }) => row.pid === pid).eligibility,
      ).toBe("live");
      const live = (await subject.list()).processes.find((row) => row.pid === pid)!;
      expect(live.eligibility).toBe("live");
      expect(live.liveOwners).toHaveLength(1);
      expect((await subject.retire()).outcomes).toEqual([]);
      expect(await processIdentity(pid)).toBeDefined();
      await herdr.cli("pane", "close", herdr.pane);
      registration(); // detachment preserves bounded recovery provenance
      if (mode === "independent") {
        await client.request("thread/start", {
          cwd: root,
          approvalPolicy: "never",
          sandbox: "read-only",
          persistExtendedHistory: true,
        });
        const siblingFinding = (await subject.list()).processes.find((row) => row.pid === pid)!;
        expect(siblingFinding.eligibility).toBe("report-only");
        expect(siblingFinding.reason).toBe("independent_or_unknown_native_thread");
        expect((await subject.retire()).outcomes).toEqual([]);
        return;
      }
      client.close();
      socket.terminate();
      client = undefined;
      const archivePath = join(stateRoot, "local-codex-seats.json.released.json");
      const archive = JSON.parse(await readFile(archivePath, "utf8"));
      const record = archive.seats[0];
      expect(record.pid).toBe(pid);
      expect(record.threadId).toBe(threadId);
      const closedFinding = (await subject.list()).processes.find((row) => row.pid === pid)!;
      expect(closedFinding.reason).toBe("original_closed_hire_idle");
      expect(closedFinding.eligibility).toBe("verified-closed-hire");
      expect(closedFinding.proof?.nativeThreads).toEqual([{ id: threadId, status: "idle" }]);
      expect(closedFinding.proof?.birth).toBe((await processIdentity(pid))!.startTime);
      expect(JSON.stringify(closedFinding)).not.toContain("approvalPolicy");
      // Missing/uncertain closure and changed process receipt are report-only.
      await journal("close_unconfirmed");
      expect((await subject.retire()).outcomes).toEqual([]);
      await journal();
      await writeFile(archivePath, JSON.stringify({ ...archive, seats: [{ ...record, start: "1.000000" }] }));
      expect((await subject.list()).processes.find((row) => row.pid === pid)?.eligibility).toBe(
        "report-only",
      );
      expect((await subject.retire()).outcomes).toEqual([]);
      await writeFile(archivePath, JSON.stringify(archive));
      const ownershipPath = join(stateDir, "herdr-watches.json.owners.json");
      const ownership = JSON.parse(await readFile(ownershipPath, "utf8"));
      await writeFile(
        ownershipPath,
        JSON.stringify({
          ...ownership,
          hires: ownership.hires.map((row: object) => ({ ...row, hired: false })),
        }),
      );
      expect((await subject.retire()).outcomes).toEqual([]);
      await writeFile(ownershipPath, JSON.stringify(ownership));
      const missingBinding = new FleetHarnessProcesses({
        stateRoot,
        binding: () => ({ ...binding, socketPath: join(root, "missing.sock") }),
      });
      expect((await missingBinding.list()).censusComplete).toBe(false);
      expect((await missingBinding.retire()).outcomes).toEqual([]);
      const auditPath = join(stateDir, "harness-retirement.jsonl");
      await writeFile(auditPath, JSON.stringify({ pid, birth: record.start, outcome: "term-intent" }) + "\n");
      const restarted = new FleetHarnessProcesses({ stateRoot, binding: () => binding });
      expect((await restarted.retire()).outcomes).toEqual([{ pid, outcome: "prior_exit_unconfirmed" }]);
      expect(await processIdentity(pid)).toBeDefined();
      await rm(auditPath);
      const result = (await runAgentsCommand(["processes", "retire"], cliOptions)) as Awaited<
        ReturnType<typeof subject.retire>
      >;
      expect(
        result.outcomes,
        JSON.stringify({
          outcomes: result.outcomes,
          remaining: result.after.processes.find((row) => row.pid === pid),
          childExit: child.exitCode,
          childSignal: child.signalCode,
        }),
      ).toEqual([{ pid, outcome: "retired" }]);
      expect(result.after.processes.some((row) => row.pid === pid)).toBe(false);
      expect(await processIdentity(pid)).toBeUndefined();
      const audit = await readFile(join(stateDir, "harness-retirement.jsonl"), "utf8");
      expect(audit).toContain('"term-intent"');
      expect(audit).toContain('"retired"');
      expect(audit).not.toContain("Bearer");
    } finally {
      subject.close();
      if (http) {
        http.closeAllConnections();
        await new Promise<void>((resolve) => http!.close(() => resolve()));
      }
      service?.close();
      client?.close();
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const done = once(child, "exit");
        child.kill("SIGTERM");
        await done;
      }
      await herdr.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
