import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { OperatorSeatBindings } from "../src/operator-seat-bindings.ts";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { SettingsStore } from "@clankie/settings";
import { expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { releaseAtLeast } from "../src/captain/native-release.ts";
import { runOpenCodeSeat } from "../../tui/src/command/opencode-seat.ts";

// VUH-2348: a real OpenCode (1.18 or newer) server runs the shipped seat plugin against the
// real seat bridge, service and captain. The model provider is controlled so a
// turn can end in a provider error on demand; kernel observations are bounded
// to the launcher-owned pump below. OpenCode and Clankie state
// live in a temporary home; the plugin's `clankie mcp` entry resolves to a shim.

const repoRoot = join(import.meta.dirname, "../../..");
const opencode = (() => {
  try {
    return execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
})();

async function until(check: () => boolean, label: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

it.skipIf(!opencode || !releaseAtLeast(opencode, "1.18.0"))(
  "a slow context read and a provider error each fail one turn, later turns deliver, and the first stop cause survives",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-resilience-"));
    const dirs = {
      home: join(root, "home"),
      config: join(root, "config"),
      data: join(root, "data"),
      state: join(root, "state"),
      cache: join(root, "cache"),
      work: join(root, "work"),
      bin: join(root, "bin"),
    };
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dirs.bin, "clankie"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(dirs.bin, "clankie"), 0o755);
    const bearer = `clankie_op_${"a".repeat(43)}`;
    const captain = createCaptain(
      {
        herdrAvailable: () => false,
        presence: { listSessions: async () => [] },
        embodiment: { getLiveSession: async () => undefined },
        // Memory is a fixture boundary here; identity comes from the real lane prompt.
        memory: { recallMemoryCard: async () => "Fixture memory card." },
      } as unknown as CaptainDeps,
      {
        repoRoot: root,
        stateDir: root,
        workingDirectory: dirs.work,
        settings: new SettingsStore(join(root, "settings.json")),
      },
    );
    // The launcher hosts the pump in this fixture. Substitute only kernel
    // observations of its owned HTTP sockets and its actual spawned child;
    // registration and admission remain real. This is not native proof coverage.
    const launcher = { pid: process.pid, ppid: process.ppid, birth: [randomUUID(), "0"] as [string, string] };
    let harness: { pid: number; ppid: number; birth: [string, string] } | undefined;
    const launcherSockets = new WeakSet<Socket>();
    const operatorSeatBindings = new OperatorSeatBindings({
      birth: async (pid) =>
        pid === launcher.pid ? launcher.birth : harness?.pid === pid ? harness.birth : undefined,
      processes: async (controllerPid, harnessPid) => {
        if (controllerPid !== launcher.pid || harness?.pid !== harnessPid) return undefined;
        return {
          schemaVersion: 1,
          processes: [launcher, harness].map((entry) => ({
            ...entry,
            uid: process.getuid?.() ?? 501,
            executable: process.execPath,
            argv: [],
          })),
        };
      },
      socket: async (socket) =>
        launcherSockets.has(socket)
          ? {
              schemaVersion: 1,
              owner: {
                pid: launcher.pid,
                uid: process.getuid?.() ?? 501,
                birth: launcher.birth,
                socket: "fixture-launcher",
              },
              ancestors: [launcher],
            }
          : undefined,
    });
    const app = await createClankieApp({
      operatorSeatBindings,
      captain: new Proxy(captain, {
        get: (target, key, receiver) =>
          key === "laneToolBank"
            ? async () => ({ lane: "operator", tools: [] })
            : Reflect.get(target, key, receiver),
      }),
      eventLogPath: join(root, "events.jsonl"),
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === `Bearer ${bearer}`
          ? { operatorId: "fixture-owner" }
          : undefined,
    });
    // The identity read stalls past the client's 10 s bound once, as it did under fleet load.
    let stallPrompts = 0;
    let promptReads = 0;
    const http = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request, env) => {
        if (new URL(request.url).pathname === "/v1/captain/prompt") {
          promptReads++;
          if (stallPrompts > 0) {
            stallPrompts--;
            await new Promise((resolve) => setTimeout(resolve, 11_000));
          }
        }
        launcherSockets.add(env.incoming.socket);
        return app.app.fetch(request, env);
      },
    }) as HttpServer;
    if (!http.listening) await new Promise<void>((resolve) => http.once("listening", resolve));
    const host = `http://127.0.0.1:${(http.address() as { port: number }).port}`;

    const requests: string[] = [];
    let rejectNext = false;
    const provider: Server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      if (!request.url?.endsWith("/chat/completions")) {
        response.writeHead(404).end();
        return;
      }
      const title = /title/iu.test(
        JSON.stringify((JSON.parse(body) as { messages?: { role: string }[] }).messages?.[0] ?? ""),
      );
      if (!title) requests.push(body);
      if (rejectNext && !title) {
        rejectNext = false;
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: "invalid x-api-key", type: "authentication_error" } }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null) =>
        response.write(
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      chunk({ role: "assistant", content: title ? "Fixture title" : "fixture reply" }, null);
      chunk({}, "stop");
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;

    const env: NodeJS.ProcessEnv = {
      PATH: `${dirs.bin}:${process.env.PATH ?? ""}`,
      HOME: dirs.home,
      XDG_CONFIG_HOME: dirs.config,
      XDG_DATA_HOME: dirs.data,
      XDG_STATE_HOME: dirs.state,
      XDG_CACHE_HOME: dirs.cache,
      CLANKIE_SETTINGS_FILE: join(root, "settings.json"),
      CLANKIE_CREDENTIALS_FILE: join(root, "credentials.json"),
      CLANKIE_OPERATOR_TOKEN: bearer,
      CLANKIE_CONTROL_PLANE_URL: host,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model: "fake/fake-model",
        small_model: "fake/fake-model",
        provider: {
          fake: {
            npm: "@ai-sdk/openai-compatible",
            name: "Fixture",
            options: { baseURL: providerUrl, apiKey: "fixture" },
            models: { "fake-model": { name: "Fixture" } },
          },
        },
      }),
    };
    let native: ChildProcess | undefined;
    let nativeUrl: string | undefined;
    let bridge: { url: string; token: string } | undefined;
    let stderr = "";
    // The seat resolves its workspace from the launching shell's directory.
    const original = process.cwd();
    process.chdir(dirs.work);
    const seat = runOpenCodeSeat(
      { resume: false, dryRun: false },
      {
        repoRoot,
        env,
        stderr: { write: (value: string) => ((stderr += value), true) },
        // The same plugin, bridge and environment; headless so the test can drive the native API.
        spawnImpl: (command, _args, cwd, childEnv = {}, onSpawn) =>
          new Promise<number>((resolve, reject) => {
            bridge = {
              url: childEnv.CLANKIE_OPENCODE_BRIDGE!,
              token: childEnv.CLANKIE_OPENCODE_BRIDGE_TOKEN!,
            };
            native = spawn(command, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
              cwd,
              env: childEnv,
            });
            const listen = (data: Buffer) => {
              nativeUrl ??= /listening on (http:\/\/[\d.:]+)/u.exec(String(data))?.[1];
            };
            native.stdout?.on("data", listen);
            native.stderr?.on("data", listen);
            native.once("error", reject);
            native.once("exit", (code) => {
              harness = undefined;
              resolve(code ?? 0);
            });
            if (native.pid !== undefined) {
              harness = { pid: native.pid, ppid: launcher.pid, birth: [randomUUID(), "0"] };
              onSpawn?.(native.pid);
            }
          }),
      },
    );
    const receipts = () => {
      const launches = join(dirs.state, "clankie", "opencode-seat-launches");
      const [launch] = existsSync(launches) ? readdirSync(launches) : [];
      const file = launch ? join(launches, launch, "delivery.json") : "";
      return file && existsSync(file)
        ? (JSON.parse(readFileSync(file, "utf8")) as {
            failure?: string;
            warnings: string[];
            receipts: Record<string, string>;
          })
        : { warnings: [], receipts: {} };
    };
    try {
      await until(() => nativeUrl !== undefined, "OpenCode server");
      // 1. The first-context read stalls on a fresh seat's preflight; the plugin retries it.
      stallPrompts = 1;
      const session = (await (
        await fetch(`${nativeUrl}/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).json()) as { id: string };
      await until(() => captain.operatorSeatReady?.() === true, "seat delivery after a stalled context read");
      expect(promptReads).toBeGreaterThanOrEqual(2);
      expect(receipts().failure).toBeUndefined();

      // 2. A provider error ends one turn and is recorded; the seat keeps delivering.
      rejectNext = true;
      await fetch(`${nativeUrl}/session/${session.id}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "owner typed turn" }] }),
      });
      await until(
        () => receipts().warnings.some((warning) => warning.includes("invalid x-api-key")),
        "the turn's provider error in the receipts",
      );
      expect(receipts().failure).toBeUndefined();
      const get = await captain.serveOperatorConversation({
        op: "get",
        schemaVersion: 1,
        conversationId: "global-default",
      });
      if (get.op !== "get" || !get.conversation) throw new Error("Missing owned conversation");
      const text = `owner app turn ${randomUUID()}`;
      const dispatched = await fetch(`${host}/operator/v1/dispatch`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({
          op: "send",
          schemaVersion: 1,
          turn: {
            schemaVersion: 1,
            kind: "message",
            conversationId: "global-default",
            surfaceClientId: "command-center-mobile",
            expectedRevision: get.conversation.revision,
            message: text,
          },
        }),
      });
      expect(dispatched.status).toBe(200);
      await until(
        () => requests.some((body) => body.includes(text) && body.includes("clankie-seat-event")),
        "the next turn to reach the model",
      );
      await until(() => Object.values(receipts().receipts).includes("delivered"), "the delivery receipt");
      expect(receipts().failure).toBeUndefined();
      // Every model request carried the service's fresh identity, including the retried one.
      expect(requests.every((body) => body.includes("Clankie"))).toBe(true);

      // 3. A real stop keeps its first cause; a follow-on refusal does not replace it.
      await fetch(`${nativeUrl}/session/${session.id}`, { method: "DELETE" });
      await until(() => receipts().failure !== undefined, "the stop cause");
      expect(receipts().failure).toContain("session.deleted");
      await fetch(new URL("/failure", bridge!.url), {
        method: "POST",
        headers: { authorization: `Bearer ${bridge!.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: session.id,
          detail: "Error: Clankie poll failed (409); no terminal fallback",
        }),
      });
      expect(receipts().failure).toContain("session.deleted");
      native?.kill();
      await seat;
      expect(stderr).toMatch(/clankie opencode closed: Error: session\.deleted/u);
    } finally {
      process.chdir(original);
      native?.kill();
      await seat.catch(() => undefined);
      provider.close();
      http.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
