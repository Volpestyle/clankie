import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { SeatControl } from "@clankie/agent-hosts";
import { releaseAtLeast } from "../src/captain/native-release.ts";
import type { createOpenCodeNativeHost } from "../src/captain/opencode-native-host.ts";
import {
  createOpenCodeSeatAdapter,
  OPENCODE_V2_WORKER_FLOOR,
  probeOpenCodeVersion,
} from "../src/captain/opencode-seat-adapter.ts";

// Issue #168: a real OpenCode 2 TUI, in a real pseudo-terminal, loads the
// shipped V2 worker plugin and its private `--standalone` server. The hire,
// controller, WebSocket admission, plugin runtime and OpenCode's own session
// inbox are real; only the model provider and the Herdr pane/process proof are
// fixtures. Nothing types into the terminal: the pty is only a display.

const repoRoot = join(import.meta.dirname, "../../..");
const installed = (() => {
  try {
    const output = execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim();
    return /^opencode v(\d+\.\d+\.\d+)$/u.exec(output)?.[1];
  } catch {
    return undefined;
  }
})();
const python = (() => {
  try {
    execFileSync("python3", ["-c", "import pty, fcntl, termios"]);
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

async function until<T>(check: () => T | undefined | false, label: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

it.skipIf(!installed || !releaseAtLeast(installed, OPENCODE_V2_WORKER_FLOOR) || !python)(
  "an OpenCode 2 hire starts natively, takes its brief, steers and queues follow-ups with receipts, reports state, settles, interrupts and exits",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "opencode2-worker-")));
    const dirs = {
      home: join(root, "home"),
      config: join(root, "config"),
      data: join(root, "data"),
      state: join(root, "state"),
      cache: join(root, "cache"),
      work: join(root, "work"),
      bin: join(root, "bin"),
      captain: join(root, "captain"),
    };
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
    // The worker MCP projection names `clankie mcp --fleet`; a shim stands in.
    writeFileSync(join(dirs.bin, "clankie"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(dirs.bin, "clankie"), 0o755);

    // An OpenAI-compatible provider. A prompt containing SLOW holds its stream
    // open so a turn stays running while follow-ups arrive.
    const requests: string[] = [];
    const provider: Server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      if (!request.url?.endsWith("/chat/completions")) {
        response.writeHead(404).end();
        return;
      }
      const messages = (JSON.parse(body) as { messages?: unknown[] }).messages ?? [];
      const latest = JSON.stringify(messages.at(-1) ?? "");
      requests.push(JSON.stringify(messages));
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null) =>
        response.write(
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      chunk({ role: "assistant", content: "fixture " }, null);
      if (latest.includes("SLOW")) await new Promise((resolve) => setTimeout(resolve, 5000));
      if (response.destroyed) return;
      chunk({ content: "reply" }, null);
      chunk({}, "stop");
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;

    const executable = await realpath(execFileSync("which", ["opencode"], { encoding: "utf8" }).trim());
    const version = await probeOpenCodeVersion(executable);
    expect(version).toBe(installed);
    let tui: ChildProcess | undefined;
    let exited: number | null | undefined;
    // Pane and process proof are Herdr/kernel observations; fixture them only.
    const native = {
      createCommandTab: async () => "w1:p1",
      capture: async (paneId: string) => ({
        paneId,
        terminalId: "term_oc2",
        check: async () => tui !== undefined && exited === undefined,
        proof: async () => ({ pid: tui?.pid ?? 0 }),
        report: async () => {},
      }),
    } as unknown as ReturnType<typeof createOpenCodeNativeHost>;
    const adapter = createOpenCodeSeatAdapter({
      repoRoot,
      stateDir: dirs.captain,
      native,
      discover: async () => ({ executable, version }),
      timeoutMs: 30_000,
    });
    try {
      const prepared = await adapter.prepare!({
        harness: "opencode",
        cwd: dirs.work,
        brief: "Fixture brief SLOW",
        model: "fake/fake-model",
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
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
      // V2 runs its own private server, never the owner's shared service, and
      // takes no --model flag: the plugin creates the session with the model.
      expect(prepared.command).toEqual([executable, "--standalone", dirs.work]);
      expect(prepared.env?.OPENCODE_DB).toBeUndefined();
      tui = spawn("python3", ["-c", PTY, ...prepared.command], {
        cwd: dirs.work,
        env: {
          PATH: `${dirs.bin}:${process.env.PATH ?? ""}`,
          HOME: dirs.home,
          TERM: "xterm-256color",
          XDG_CONFIG_HOME: dirs.config,
          XDG_DATA_HOME: dirs.data,
          XDG_STATE_HOME: dirs.state,
          XDG_CACHE_HOME: dirs.cache,
          ...prepared.env,
        },
        stdio: "ignore",
      });
      tui.once("exit", (code) => {
        exited = code;
      });
      const started = await prepared.start({ paneId: "w1:p1", name: "oc2-worker", run: async () => {} });
      if (started.outcome !== "started") throw new Error(`Hire failed: ${JSON.stringify(started)}`);
      const control: SeatControl = started.control;
      expect(control.deliveryModes).toEqual(["steer", "queue"]);
      expect(control.ref.sessionId).toMatch(/^ses_/u);

      // The brief reached the model through the session inbox, with the
      // fixture model the hire named, and its turn is still streaming.
      await until(() => requests.some((body) => body.includes("Fixture brief SLOW")), "the brief turn");
      expect(await control.status()).toBe("working");

      // Steer lands inside the running turn; queue waits for it to end.
      const steered = await control.send("Steered follow-up", { delivery: "steer" });
      expect(steered).toMatchObject({ outcome: "accepted", state: "steered", deliveryStage: "consumed" });
      const queued = await control.send("Queued follow-up", { delivery: "queue" });
      expect(queued).toMatchObject({ outcome: "accepted", state: "queued", deliveryStage: "consumed" });

      // Settlement follows the last message to its turn's idle marker.
      const settled = await control.settled(AbortSignal.timeout(60_000));
      expect(settled).toMatchObject({ type: "turn_completed", ok: true });
      expect(settled.type === "turn_completed" && settled.text).toContain("fixture reply");
      expect(await control.status()).toBe("idle");
      const steerAt = requests.findIndex((body) => body.includes("Steered follow-up"));
      const queueAt = requests.findIndex((body) => body.includes("Queued follow-up"));
      expect(steerAt).toBeGreaterThan(0);
      // The steered message joined the brief's turn before the queued one ran.
      expect(requests[steerAt]).not.toContain("Queued follow-up");
      expect(queueAt).toBeGreaterThan(steerAt);

      // An idle send starts a turn; interrupt stops exactly that running turn.
      const slow = await control.send("Long SLOW task");
      expect(slow).toMatchObject({ outcome: "accepted", state: "started" });
      await until(() => requests.some((body) => body.includes("Long SLOW task")), "the long turn");
      expect(await control.interrupt()).toBe(true);
      const stopped = await control.settled(AbortSignal.timeout(30_000));
      expect(stopped).toMatchObject({ type: "turn_completed", ok: false, stopReason: "interrupted" });

      // Exit goes through the TUI's own command; its private server leaves with it.
      await control.exit!();
      await until(() => exited !== undefined, "the TUI to exit", 20_000);
      expect(await control.status()).toBe("offline");
    } finally {
      tui?.kill();
      provider.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
