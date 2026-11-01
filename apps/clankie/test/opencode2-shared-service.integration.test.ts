import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { releaseAtLeast } from "../src/captain/native-release.ts";
import { createFleetSeatControl } from "../src/captain/fleet-seat-control.ts";
import { DeliveryFence } from "../src/captain/delivery-fence.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { OPENCODE_V2_WORKER_FLOOR } from "../src/captain/opencode-seat-adapter.ts";

// ADR 0337: an OpenCode 2 session the owner opened by hand takes Clankie's
// message in its own inbox on OpenCode's shared service. A real OpenCode 2 TUI,
// opened without --standalone, starts and connects to the real shared service.
// Fleet seat control, the delivery fence, the service registration and the
// kernel's socket table (lsof) are real; only Herdr's pane, process and session
// report are fixtures, shaped as Herdr's OpenCode integration reports them.

const installed = (() => {
  try {
    const output = execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim();
    return /^opencode v(\d+\.\d+\.\d+)$/u.exec(output)?.[1];
  } catch {
    return undefined;
  }
})();
const tools = (() => {
  try {
    execFileSync("python3", ["-c", "import pty, fcntl, termios"]);
    execFileSync("lsof", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// A display-only terminal: fixed size, output drained, no input ever written.
const PTY = `
import os, sys, pty, fcntl, termios, struct, signal
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
print(pid, flush=True)
signal.signal(signal.SIGTERM, lambda *_: os.kill(pid, signal.SIGTERM))
while True:
    try:
        if not os.read(fd, 65536):
            break
    except OSError:
        break
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, label: string) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

it.skipIf(!installed || !releaseAtLeast(installed, OPENCODE_V2_WORKER_FLOOR) || !tools)(
  "a hand-opened OpenCode 2 session takes the owner's message in its own inbox, steered and queued, and nothing else is sent to",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "opencode2-shared-")));
    const dirs = {
      config: join(root, "config"),
      data: join(root, "data"),
      state: join(root, "state"),
      cache: join(root, "cache"),
      work: join(root, "work"),
    };
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
    // The owner's own service settings choose its port, so this never meets a real one.
    mkdirSync(join(dirs.config, "opencode"), { recursive: true });
    writeFileSync(join(dirs.config, "opencode", "service.json"), JSON.stringify({ port: await freePort() }));

    // An OpenAI-compatible provider. SLOW holds a turn open while follow-ups arrive.
    const provider: Server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      if (!request.url?.endsWith("/chat/completions")) {
        response.writeHead(404).end();
        return;
      }
      const messages = (JSON.parse(body) as { messages?: unknown[] }).messages ?? [];
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null) =>
        response.write(
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      chunk({ role: "assistant", content: "fixture " }, null);
      if (JSON.stringify(messages.at(-1) ?? "").includes("SLOW"))
        await new Promise((resolve) => setTimeout(resolve, 5000));
      if (response.destroyed) return;
      chunk({ content: "reply" }, null);
      chunk({}, "stop");
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;

    const executable = await realpath(execFileSync("which", ["opencode"], { encoding: "utf8" }).trim());
    const registration = join(dirs.state, "opencode", "service.json");
    let display: ChildProcess | undefined;
    let tuiPid: number | undefined;
    try {
      // The owner opens OpenCode by hand: no --standalone, so the TUI joins the shared service.
      display = spawn("python3", ["-c", PTY, executable, dirs.work], {
        cwd: dirs.work,
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          XDG_CONFIG_HOME: dirs.config,
          XDG_DATA_HOME: dirs.data,
          XDG_STATE_HOME: dirs.state,
          XDG_CACHE_HOME: dirs.cache,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            model: "fake/fake-model",
            provider: {
              fake: {
                npm: "@ai-sdk/openai-compatible",
                name: "Fixture",
                options: { baseURL: providerUrl, apiKey: "fixture" },
                models: { "fake-model": { name: "Fixture" } },
              },
            },
          }),
        },
      });
      display.stdout!.on("data", (chunk: Buffer) => (tuiPid ??= Number(String(chunk).trim())));
      const service = await until(() => {
        if (!existsSync(registration)) return undefined;
        const parsed = JSON.parse(readFileSync(registration, "utf8")) as {
          url: string;
          pid: number;
          password: string;
        };
        return parsed.password ? parsed : undefined;
      }, "the shared service's registration");
      const auth = `Basic ${Buffer.from(`opencode:${service.password}`).toString("base64")}`;
      const api = async (method: string, path: string, body?: unknown) => {
        const response = await fetch(new URL(path, service.url), {
          method,
          headers: { authorization: auth, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, json: (await response.json().catch(() => undefined)) as any };
      };
      await until(
        async () => (await api("GET", "/api/info").catch(() => undefined))?.status === 200,
        "the service",
      );
      const tui = await until(() => tuiPid, "the TUI's pid");
      // The TUI holds its connection to the shared service once it is up.
      await until(
        () =>
          execFileSync("lsof", ["-p", String(tui), "-Fn"], { encoding: "utf8" }).includes(
            `:${new URL(service.url).port}`,
          ),
        "the TUI's connection to the shared service",
      );
      // The session Herdr's OpenCode integration would report for the pane.
      const created = await api("POST", "/api/session", {
        title: "owner",
        location: { directory: dirs.work },
      });
      const sessionId = created.json.data.id as string;

      let argv = [executable, dirs.work];
      const agent = (session: string): HerdrAgentSnapshot => ({
        paneId: "w1:p1",
        terminalId: "owner",
        agent: "opencode",
        status: "idle",
        title: "owner",
        session: { source: "herdr:opencode", kind: "id", value: session },
        workingDirectory: dirs.work,
      });
      let reported = agent(sessionId);
      const runner: HerdrWatchRunner = {
        get: async () => reported,
        resolveTerminal: async () => reported,
        wait: async () => reported,
        paneProcesses: async () => [{ pid: tui, name: "opencode", argv0: executable, argv }],
        openFiles: async (pid) => execFileSync("lsof", ["-p", String(pid), "-Fn"], { encoding: "utf8" }),
      };
      const receipts = join(root, "receipts.json");
      const control = createFleetSeatControl(
        runner,
        new Map(),
        undefined,
        undefined,
        undefined,
        receipts,
        undefined,
        undefined,
        { openCodeServicePath: registration },
      );

      // The app sees steer and queue on the owner's own OpenCode pane.
      expect((await control.inputCapabilities(reported))?.deliveryModes).toEqual(["steer", "queue"]);

      const first = await control.deliverToSeat("owner", "Look at the failing build SLOW");
      expect(first).toMatchObject({ outcome: "delivered", state: "started", deliveryStage: "consumed" });
      expect(JSON.stringify(first)).not.toContain(service.password);
      if (first.outcome !== "delivered") throw new Error(first.detail);
      const landed = await api("GET", `/api/session/${sessionId}/message/${first.messageId}`);
      expect(landed.status).toBe(200);
      expect(JSON.stringify(landed.json)).toContain("Look at the failing build SLOW");

      // While that turn runs, a steer joins it and a queue waits for it to end.
      const steered = await control.deliverToSeat("owner", "Check the logs too", undefined, {
        delivery: "steer",
      });
      expect(steered).toMatchObject({ outcome: "delivered", state: "steered" });
      const queued = await control.deliverToSeat("owner", "Then summarize", undefined, { delivery: "queue" });
      expect(queued).toMatchObject({ outcome: "delivered", state: "queued" });
      expect(new DeliveryFence(receipts).entries()).toEqual([]);

      // A session the shared service doesn't hold sends nothing and leaves nothing uncertain.
      reported = agent("ses_unknownsession0000000000");
      const unknown = await control.deliverToSeat("owner", "status?");
      expect(unknown.outcome).toBe("undelivered");
      expect(new DeliveryFence(receipts).entries()).toEqual([]);

      // A --standalone TUI runs its own server, so the shared service isn't its channel.
      reported = agent(sessionId);
      argv = [executable, "--standalone", dirs.work];
      expect((await control.inputCapabilities(reported))?.deliveryModes).toEqual([]);
      expect((await control.deliverToSeat("owner", "status?")).outcome).toBe("undelivered");
      argv = [executable, dirs.work];

      // A stopped service is no channel either.
      process.kill(service.pid, "SIGTERM");
      await until(() => {
        try {
          process.kill(service.pid, 0);
          return false;
        } catch {
          return true;
        }
      }, "the service to stop");
      expect((await control.deliverToSeat("owner", "status?")).outcome).toBe("undelivered");
      expect(new DeliveryFence(receipts).entries()).toEqual([]);
    } finally {
      display?.kill();
      try {
        const { pid } = JSON.parse(readFileSync(registration, "utf8")) as { pid: number };
        process.kill(pid, "SIGTERM");
      } catch {
        // Already stopped.
      }
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
