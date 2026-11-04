import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runCodexSeat } from "../src/command/codex-seat.ts";
import { runGrokSeat } from "../src/command/grok-seat.ts";
import { runPrimeSeat } from "../src/command/prime-seat.ts";
import { runSeatCommand } from "../src/command/seat.ts";

// Every harness keeps one resume record per command. A throwaway `--new` seat must
// leave it alone, and fill it only when it is empty, so `--resume` keeps its target.
const repoRoot = join(import.meta.dirname, "../../..");
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function fixture() {
  // A Unix socket path has to stay short, so not the platform's long temp directory.
  const root = await realpath(
    await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "seat-")),
  );
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "clankie"));
  await mkdir(join(root, "bin"));
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    PATH: join(root, "bin"),
    XDG_STATE_HOME: root,
    CLAUDE_CONFIG_DIR: root,
    CODEX_HOME: join(root, "codex-home"),
    CLANKIE_CONTROL_PLANE_URL: "http://127.0.0.1:1",
    CLANKIE_SETTINGS_FILE: join(root, "settings.json"),
    CLANKIE_CREDENTIALS_FILE: join(root, "credentials.json"),
    CLANKIE_OPERATOR_TOKEN: `clankie_op_${"a".repeat(43)}`,
  };
  const fetchImpl: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/captain/seat-context") return Response.json({ conversationId: "throwaway", cwd: root });
    if (path === "/v1/operator/maximum-trust-mode")
      return Response.json({ schemaVersion: 1, enabled: false });
    return new Response("operator context");
  };
  const silent = { write: () => true };
  const options = { repoRoot, env, fetchImpl, stdout: silent, stderr: silent };
  const record = (file: string) => join(root, "clankie", file);
  const read = async (file: string) => JSON.parse(await readFile(record(file), "utf8"));
  return { root, env, options, record, read };
}

async function script(path: string, body: string) {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

const claude = (command: string) => async (f: Awaited<ReturnType<typeof fixture>>) => {
  await runSeatCommand(["--new"], {
    ...f.options,
    claudeCommand: command,
    execFileImpl: async () => ({ stdout: "Claude Code", stderr: "" }),
    spawnImpl: async () => 0,
  });
};

const codex = (command: string) => async (f: Awaited<ReturnType<typeof fixture>>) => {
  const home = join(f.root, `${command}-home`);
  await mkdir(home, { recursive: true });
  await writeFile(
    f.env.CLANKIE_SETTINGS_FILE!,
    JSON.stringify({ schemaVersion: 1, codexAccounts: [{ label: "codex2", home }] }),
  );
  let finish!: (code: number) => void;
  const view = new Promise<number>((resolve) => {
    finish = resolve;
  });
  await runCodexSeat(
    { resume: false, dryRun: false, newConversation: true },
    {
      ...f.options,
      harnessCommand: command,
      trackerOverrides: async () => [],
      execFileImpl: async (_name, args) => ({
        stdout: args.includes("list")
          ? JSON.stringify({ installed: [{ pluginId: "clankie@clankie-seat" }] })
          : "fixture",
        stderr: "",
      }),
      spawnImpl: async () => view,
      startImpl: async (start) => {
        await start.startView(["--remote", "unix:///fixture.sock"]);
        setTimeout(() => finish(0), 20);
        return {
          threadId: "throwaway-thread",
          viewArgs: [],
          send: async () => ({ turnId: "unused", state: "started" }),
          interrupt: async () => false,
          close: async () => {},
        };
      },
      connectImpl: async () => {
        throw new Error("Untrusted hooks must not connect");
      },
    },
  );
};

/** Stands in for the `grok` binary: it reports its release, and its TUI exits at once. */
const grok = async (f: Awaited<ReturnType<typeof fixture>>) => {
  f.env.GROK_HOME = join(f.root, ".grok");
  await mkdir(f.env.GROK_HOME, { recursive: true });
  await script(join(f.root, "bin/grok"), `[ "$1" = --version ] && echo 'grok 1.0.70 (fixture)'\nexit 0`);
  await runGrokSeat({ resume: false, dryRun: false, newConversation: true }, f.options).catch(() => 1);
};

/** Stands in for Prime's launcher and daemon: a session opens, and the attach exits at once. */
const prime = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const share = join(f.root, "share/prime-agent");
  await mkdir(share, { recursive: true });
  await script(join(f.root, "bin/prime-agent"), "exit 0");
  await script(join(share, "prime-agent"), "echo 0.10.0");
  f.env.PRIME_AGENT_DAEMON_SOCKET = join(f.root, "d.sock");
  const summary = {
    activeSessionId: "throwaway-active",
    sessionId: "throwaway-session",
    sessionFile: join(f.root, "session.jsonl"),
    cwd: f.root,
    lifecycle: "idle",
    activity: "idle",
  };
  const server: Server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write(
      `${JSON.stringify({
        type: "daemon_hello",
        protocol: { name: "prime-agent.daemon", version: 7 },
        appVersion: "fixture",
      })}\n`,
    );
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        const { id, command } = JSON.parse(line) as { id: string; command: { type: string } };
        socket.write(
          `${JSON.stringify({ type: "response", id, command: command.type, success: true, data: summary })}\n`,
        );
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(f.env.PRIME_AGENT_DAEMON_SOCKET, resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  await runPrimeSeat({ resume: false, dryRun: false, newConversation: true }, f.options).catch(() => 1);
};

const onDarwin = process.platform === "darwin";
it.each([
  { name: "claude", file: "seat.json", launch: claude("claude"), native: true },
  { name: "claude2", file: "seat-claude2.json", launch: claude("claude2"), native: true },
  { name: "codex", file: "codex-seat.json", launch: codex("codex"), native: true },
  { name: "codex2", file: "codex-seat-codex2.json", launch: codex("codex2"), native: true },
  { name: "grok", file: "grok-seat.json", launch: grok, native: onDarwin, after: { active: false } },
  { name: "prime", file: "prime-seat.json", launch: prime, native: true },
])("a --new $name seat fills an empty resume record and never replaces one", async (seat) => {
  if (!seat.native) return;
  const empty = await fixture();
  await seat.launch(empty);
  expect(await empty.read(seat.file)).toMatchObject({ sessionId: expect.any(String), ...seat.after });

  const owned = await fixture();
  const original = JSON.stringify({ sessionId: "the-owners-session", conversationId: "owner-chat" });
  await writeFile(owned.record(seat.file), original);
  await seat.launch(owned);
  expect(await readFile(owned.record(seat.file), "utf8")).toBe(original);
});
