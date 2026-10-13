// Manual trust-boundary integration: real Windows Herdr, Codex and kernel probes.
// Creates only an owned idle fixture; sends no provider turn or existing-seat input.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { remoteProgramCommand, type FleetShellRun, type HerdrFleet } from "../src/herdr-fleet.ts";
import { RemoteCodexSeats } from "../src/remote-codex-seats.ts";
import { createRemoteCodexControlObserver } from "../src/remote-project-proof.ts";
import { remoteCodexControl, remoteCodexServer } from "../src/captain/remote-codex-app-server.ts";
import { startCodexAppServerSeat, CodexAppServerClient } from "../src/captain/codex-app-server.ts";
import { openRemoteCodexConnection } from "../src/captain/remote-codex-connection.ts";

const run = promisify(execFile);
const enabled = process.env.REMOTE_CODEX_RESTART_NATIVE === "1";
it.skipIf(!enabled)(
  "rediscovers a detached native backend after controller loss and denies changed authority",
  async () => {
    const host = process.env.REMOTE_CODEX_NATIVE_HOST;
    const cwd = process.env.REMOTE_CODEX_NATIVE_CWD;
    if (!host || !cwd || process.env.HERDR_ENV !== "1")
      throw new Error("Explicit linked host, cwd and Herdr seat required");
    const fleet: HerdrFleet = { id: "pc", session: "default", ssh: { host, shell: "powershell" } };
    const shell: FleetShellRun = async (command, timeoutMs = 30_000) =>
      (
        await run("ssh", ["-o", "BatchMode=yes", host, command], {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    const herdr = (args: readonly string[]) =>
      shell(remoteProgramCommand("powershell", "herdr", ["--session", fleet.session, ...args]));
    const created = JSON.parse(
      await herdr(["workspace", "create", "--cwd", cwd, "--label", "VUH-2200 native proof", "--no-focus"]),
    );
    const pane: string = created.result.root_pane.pane_id;
    const workspace: string = created.result.workspace.workspace_id;
    const registrations = new RemoteCodexSeats(async () => fleet);
    let forward: ChildProcess | undefined;
    let server: Awaited<ReturnType<ReturnType<typeof remoteCodexServer>>> | undefined;
    let seat: Awaited<ReturnType<typeof startCodexAppServerSeat>> | undefined;
    const captures: string[] = [];
    const observe = () =>
      createRemoteCodexControlObserver({
        fleet: async () => fleet,
        shell:
          () =>
          async (...args) => {
            const raw = await shell(...args);
            captures.push(raw);
            return raw;
          },
      });
    try {
      seat = await startCodexAppServerSeat({
        cwd,
        threadName: "VUH-2200 idle native proof",
        config: [
          "mcp_servers.clankie.enabled=false",
          "mcp_servers.worker.enabled=false",
          "check_for_update_on_startup=false",
        ],
        server: async (input) => {
          server = await remoteCodexServer({
            fleet,
            shell,
            privateSeat: {
              pane,
              register: (launch) =>
                registrations.register(launch, () => forward === undefined || forward.exitCode === null),
            },
            spawn: (...args) => {
              forward = spawn(...args);
              return forward;
            },
          })(input);
          return server;
        },
        startView: async (args) => {
          await herdr([
            "agent",
            "start",
            `proof-${randomUUID().slice(0, 8)}`,
            "--kind",
            "codex",
            "--pane",
            pane,
            "--",
            ...args,
          ]);
        },
      });
      // The production seat adapter publishes the thread it obtained from the
      // original native controller. No prompt is needed to trigger TUI hooks.
      await herdr([
        "pane",
        "report-agent",
        pane,
        "--source",
        "herdr:codex",
        "--agent",
        "codex",
        "--state",
        "idle",
        "--agent-session-id",
        seat.threadId,
      ]);
      // A fresh observer has no launch registry or cached controller. Exact endpoint,
      // listener owner, native markers and lifetimes must establish the backend.
      const before = await observe()(fleet.id, pane, seat.threadId);
      expect(before).toBeDefined();
      expect(before?.server.pid).not.toBe(before?.tui.pid);
      expect(before?.chains.server).toHaveLength(1);
      expect(registrations.server(fleet, pane)?.pid).toBe(before?.server.pid);
      forward!.kill("SIGTERM"); // Our local SSH child only; no Windows process signal.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const cold = await observe()(fleet.id, pane, seat.threadId);
      expect(registrations.server(fleet, pane)).toBeUndefined();
      expect(cold).toEqual(before);
      const connection = await openRemoteCodexConnection(fleet, cold!.endpoint);
      expect(connection).toBeDefined();
      try {
        const client = new CodexAppServerClient(connection!.socket, () => {}, 5000);
        await client.initialize(true);
        const loaded = await client.request("thread/loaded/list", {});
        expect(loaded).toMatchObject({ data: [seat.threadId], nextCursor: null });
        expect(await observe()(fleet.id, pane, seat.threadId, connection!.connection)).toEqual(cold);
        // A real connection's wrong server half and wrong native session must deny.
        expect(await observe()(fleet.id, pane, `${seat.threadId}-wrong`)).toBeUndefined();
        expect(
          await observe()(fleet.id, pane, seat.threadId, { ...connection!.connection, serverPort: 1 }),
        ).toBeUndefined();
        client.close();
      } finally {
        connection?.close();
      }
      // Exercise real native queue preparation, but revoke authority before input.
      const denied = await remoteCodexControl(fleet, shell, herdr, `pc/${pane}`, { mode: "queue" })(
        seat.threadId,
        "Must never be submitted",
        undefined,
        undefined,
        async () => false,
      );
      expect(denied).toMatchObject({ outcome: "undelivered", deliveryStage: "unavailable" });
      // Explicit fixture teardown may stop its backend. A cold observer must refuse.
      await server!.close();
      expect(await observe()(fleet.id, pane, seat.threadId)).toBeUndefined();
      const missing = await remoteCodexControl(fleet, shell, herdr, `pc/${pane}`, { mode: "queue" })(
        seat.threadId,
        "Must never be submitted",
      );
      expect(missing).toMatchObject({
        outcome: "undelivered",
        deliveryStage: "unavailable",
        detail: expect.stringContaining(`pc:${seat.threadId}`),
      });
      await mkdir(".local/vuh-2200", { recursive: true });
      await writeFile(
        ".local/vuh-2200/native-proof.json",
        JSON.stringify(
          {
            pane,
            workspace,
            threadId: seat.threadId,
            before,
            cold,
            denied,
            missing,
            captures: captures.map((raw) => JSON.parse(raw)),
          },
          null,
          2,
        ),
      );
    } finally {
      await mkdir(".local/vuh-2200", { recursive: true });
      await writeFile(
        ".local/vuh-2200/native-captures.json",
        JSON.stringify(
          captures.map((raw) => JSON.parse(raw)),
          null,
          2,
        ),
      );
      await seat?.close();
      await server?.close();
      await herdr(["workspace", "close", workspace]);
    }
  },
  120_000,
);
