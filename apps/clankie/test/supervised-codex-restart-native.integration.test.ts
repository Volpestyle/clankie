import { once } from "node:events";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import { createRuntimeUpdateRoutes } from "../src/runtime-update-routes.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { SupervisedCodexRestart } from "../src/captain/supervised-codex-restart.ts";
import {
  CodexAppServerClient,
  openCodexSocket,
  startCodexAppServerSeat,
} from "../src/captain/codex-app-server.ts";
import { workerSkills } from "../src/captain/worker-skills.ts";
import { LocalCodexSeats, type LocalCodexRegistration } from "../src/local-codex-seats.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { nativeProcessStart, observeNativeBirth } from "../src/local-fleet-process.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";
import { runWorkerToolRestartCommand } from "../../tui/src/command/harness.ts";

// Manual only. Real installed Codex + Herdr, zero model turns and no existing lane input.
it.skipIf(process.env.SUPERVISED_CODEX_RESTART_TEST !== "1")(
  "supervises native idle quit and resumes the exact owned thread in the same pane",
  async () => {
    const evidence = resolve(".local/1739", `supervised-${Date.now()}`);
    const herdr = await isolatedHerdr(evidence);
    const cwd = resolve(import.meta.dirname, "../../..");
    const launch = await workerSkills(
      "codex",
      cwd,
      herdr.root,
      process.env.SUPERVISED_CODEX_ACCOUNT_HOME ??
        (() => {
          throw new Error("Explicit existing account home required");
        })(),
      { opinionated: false, exclude: [] },
      cwd,
    );
    const home = launch.env!.CODEX_HOME!;
    const created = await herdr.cli(
      "workspace",
      "create",
      "--cwd",
      cwd,
      "--no-focus",
      "--env",
      `CODEX_HOME=${home}`,
      "--env",
      `CLANKIE_CODEX_ISOLATED_HOME=${home}`,
    );
    const pane = created.result.root_pane.pane_id as string;
    const runner = createHerdrWatchRunner(
      undefined,
      async (args) =>
        args[0] === "pane" && args[1] === "read"
          ? herdr.cliText(...args)
          : JSON.stringify(await herdr.cli(...args)),
      undefined,
      {
        localCodexBinding: async () => ({ socketPath: herdr.socketPath, session: "default" }),
        localCodexRecordsPath: join(herdr.root, "local-codex-seats.json"),
      },
    );
    let registration: LocalCodexRegistration | undefined;
    const registry = new LocalCodexSeats(
      () => ({ runtime: "external", session: "default", socketPath: herdr.socketPath }),
      undefined,
      {
        path: join(herdr.root, "local-codex-seats.json"),
        observeOccupant: async (target) => {
          const observed = await runner.get(target);
          return observed.session ? occupantIdForHerdrSession(observed.session) : undefined;
        },
      },
    );
    let serverPid = 0,
      nativeTurns = 0;
    let seat: Awaited<ReturnType<typeof startCodexAppServerSeat>> | undefined;
    let client: CodexAppServerClient | undefined;
    let http: ReturnType<typeof serve> | undefined;
    try {
      seat = await startCodexAppServerSeat({
        cwd,
        config: [
          'cli_auth_credentials_store="file"',
          "mcp_servers={}",
          "mcp_servers.clankie.enabled=true",
          'mcp_servers.clankie.command="clankie"',
          'mcp_servers.clankie.args=["mcp","--fleet"]',
          'mcp_servers.clankie.env_vars=["HERDR_PANE_ID","HERDR_SOCKET_PATH","CLANKIE_STATE"]',
        ],
        env: { ...launch.env, HERDR_SOCKET_PATH: herdr.socketPath, HERDR_PANE_ID: pane },
        catalogRefreshHome: home,
        onServerStarted: (pid) => {
          serverPid = pid;
          registration = registry.register(pid, pane);
        },
        onEvent: (event) => {
          if (event.method === "turn/started") nativeTurns++;
        },
        startView: async (args) => {
          const endpoint = args[args.indexOf("--remote") + 1]!;
          const socket = await openCodexSocket(`ws+unix://${endpoint.slice(7)}:/`);
          if (!socket) throw new Error("Fixture controller unavailable");
          const accountReader = new CodexAppServerClient(socket, () => {});
          await accountReader.initialize(true);
          const status = (await accountReader.request("account/read", { refreshToken: false })) as {
            account?: { type?: string };
            requiresOpenaiAuth?: boolean;
          };
          const cfg = (await accountReader.request("config/read", { cwd, includeLayers: true })) as {
            config?: { cli_auth_credentials_store?: string };
            layers?: { name: unknown; version: unknown; disabledReason: unknown }[];
          };
          await writeFile(
            join(evidence, "account-kind.json"),
            JSON.stringify({
              accountPresent: status.account != null,
              accountKeys: Object.keys(status.account ?? {}),
              accountType: status.account?.type ?? null,
              requiresOpenaiAuth: status.requiresOpenaiAuth,
              credentialStore: cfg.config?.cli_auth_credentials_store,
              userLayers: cfg.layers?.map(({ name, version, disabledReason }) => ({
                name,
                version,
                disabledReason,
              })),
              authFilePresent: (await stat(join(home, "auth.json")).catch(() => undefined)) !== undefined,
            }),
          );
          accountReader.close();
          await runner.runInPane!(pane, ["env", `CODEX_HOME=${home}`, "codex", ...args]);
          await delay(1_000);
          await writeFile(
            join(evidence, "startup-screen.txt"),
            await runner.readPane!(pane, "visible", "text"),
          );
        },
      });
      const endpoint = seat.viewArgs[seat.viewArgs.indexOf("--remote") + 1]!;
      const socket = await openCodexSocket(`ws+unix://${endpoint.slice(7)}:/`);
      if (!socket) throw new Error("Owned native controller unavailable");
      client = new CodexAppServerClient(socket, () => {});
      await client.initialize(true);
      // Native persistence without a provider/model call: one owned fixture context item.
      await client.request("thread/inject_items", {
        threadId: seat.threadId,
        items: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Owned restart boundary fixture; no model turn requested." },
            ],
          },
        ],
      });
      const native = (await client.request("thread/read", {
        threadId: seat.threadId,
        includeTurns: false,
      })) as { thread: { id: string; path: string; cwd: string } };
      const thread = native.thread;
      await registration?.bindSession?.(thread.id, endpoint);
      // The production Codex adapter publishes this exact native thread/read
      // identity before returning an admitted hire; no model turn is involved.
      await herdr.cli(
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
        thread.id,
      );
      const fileStat = await stat(thread.path);
      const start = nativeProcessStart((await observeNativeBirth(serverPid))!);
      const restart = new SupervisedCodexRestart({
        directory: join(herdr.root, "restarts"),
        processHelper: join(cwd, "integrations/opencode-plugin/process-birth.py"),
        runner,
        binding: async () => ({ runtime: "external", session: "default", socketPath: herdr.socketPath }),
        remoteServer: () => ({ pid: serverPid, start, endpoint }),
        resolve: async (ref) => {
          expect(ref).toBe(`local:${thread.id}`);
          return {
            ref,
            host: "local",
            sessionId: thread.id,
            workingDirectory: thread.cwd,
            file: { harness: "codex", path: thread.path, size: fileStat.size, mtimeMs: fileStat.mtimeMs },
          };
        },
        prepare: async (_saved, originalHome) => {
          expect(originalHome).toBe(home);
          return { home };
        },
        admitted: async () => true,
        changed: () => {},
      });
      const token = "owned-supervised-restart";
      const app = createRuntimeUpdateRoutes({
        authorize: async (request) =>
          request.headers.get("authorization") === `Bearer ${token}`
            ? { guard: async () => {}, current: () => true }
            : undefined,
        restartWorkerTools: (input, authority) =>
          restart.restart(input.paneId, {
            owner: { conversationId: "owned-fixture" },
            current: authority.current,
            authorize: async () => {
              await authority.guard();
              return authority.current();
            },
          }),
      });
      http = serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
      if (!http.listening) await once(http, "listening");
      const address = http.address();
      if (!address || typeof address === "string") throw new Error("HTTP listener unavailable");
      const options = { host: `http://127.0.0.1:${address.port}`, env: { CLANKIE_OPERATOR_TOKEN: token } };
      const before = await runner.get(pane);
      const state = (await client.request("thread/read", { threadId: thread.id, includeTurns: false })) as {
        thread: { status: unknown };
      };
      await writeFile(
        join(evidence, "idle-state.json"),
        JSON.stringify({ status: before.status, nativeStatus: state.thread.status }),
      );
      const beforePid = (await runner.paneProcesses!(pane)).find((row) => row.name === "codex")!.pid;
      const denied = await runWorkerToolRestartCommand(["restart-tools", "--pane", pane], {
        ...options,
        env: { CLANKIE_OPERATOR_TOKEN: "wrong-owned-bearer" },
      }).catch((error: Error) => ({ error: error.message }));
      expect(denied).toMatchObject({ error: expect.stringContaining("403") });
      const alias = await runWorkerToolRestartCommand(
        ["restart-tools", "--pane", before.terminalId],
        options,
      ).catch((error: Error) => ({ error: error.message }));
      expect(alias).toMatchObject({ error: expect.stringContaining("400") });
      // Real styled composer draft; never submit it, and clear only this owned input.
      await herdr.cli("pane", "send-text", pane, "owned unsent draft");
      await delay(100);
      const draftRefusal = await runWorkerToolRestartCommand(["restart-tools", "--pane", pane], options);
      await writeFile(join(evidence, "draft-refusal.json"), JSON.stringify(draftRefusal));
      expect(draftRefusal).toMatchObject({
        outcome: "refused",
        reason: "unsent_draft",
      });
      expect((await runner.paneProcesses!(pane)).find((row) => row.name === "codex")!.pid).toBe(beforePid);
      await herdr.cli("agent", "send-keys", pane, "ctrl+u");
      await delay(100);
      const result = await runWorkerToolRestartCommand(["restart-tools", "--pane", pane], options);
      await writeFile(
        join(evidence, "result.json"),
        JSON.stringify(
          { result, beforePid, beforeSeatId: before.terminalId, nativeTurns, modelTurnsRequested: 0 },
          null,
          2,
        ),
      );
      await writeFile(
        join(evidence, "after-state.json"),
        JSON.stringify(
          {
            panes: await runner.list!(),
            processInfo: await herdr.cli("pane", "process-info", "--pane", pane),
            screen: await runner.readPane!(pane, "visible", "text"),
          },
          null,
          2,
        ),
      );
      expect(result).toMatchObject({
        outcome: "restarted",
        threadId: thread.id,
        resumedSeatId: before.terminalId,
      });
      const after = await runner.get(pane);
      expect(after.paneId).toBe(pane);
      expect(after.terminalId).toBe(before.terminalId);
      expect(after.session?.value).toBe(thread.id);
      expect(after.workingDirectory).toBe(before.workingDirectory);
      expect((await runner.paneProcesses!(pane)).find((row) => row.name === "codex")!.pid).not.toBe(
        beforePid,
      );
      expect(nativeTurns).toBe(0);
      expect((await readFile(thread.path, "utf8")).includes("Owned restart boundary fixture")).toBe(true);
      const afterPid = (await runner.paneProcesses!(pane)).find((row) => row.name === "codex")!.pid;
      // Real native busy task through Codex's local shell escape hatch. This
      // requests no model turn and runs only a bounded owned sleep process.
      await client.request("thread/shellCommand", {
        threadId: thread.id,
        command: "sleep 6",
        timeoutMs: 7_000,
      });
      const nativeStatus = async () => {
        const value = (await client!.request("thread/read", {
          threadId: thread.id,
          includeTurns: false,
        })) as {
          thread: { status: { type: string } };
        };
        return value.thread.status.type;
      };
      const busyDeadline = Date.now() + 2_000;
      while ((await nativeStatus()) !== "active" && Date.now() < busyDeadline) await delay(25);
      expect(await nativeStatus()).toBe("active");
      const busy = await runWorkerToolRestartCommand(["restart-tools", "--pane", pane], options);
      expect(busy).toMatchObject({ outcome: "refused", reason: "busy" });
      const idleDeadline = Date.now() + 7_000;
      while ((await nativeStatus()) !== "idle" && Date.now() < idleDeadline) await delay(25);
      expect(await nativeStatus()).toBe("idle");
      await writeFile(join(evidence, "boundaries.json"), JSON.stringify({ denied, alias, busy }, null, 2));
      expect((await runner.paneProcesses!(pane)).find((row) => row.name === "codex")!.pid).toBe(afterPid);
    } finally {
      client?.close();
      if (http) {
        if ("closeAllConnections" in http) http.closeAllConnections();
        await new Promise<void>((done) => http!.close(() => done()));
      }
      await seat?.close();
      registration?.();
      await delay(1_000);
      await herdr.close();
    }
  },
  120_000,
);
