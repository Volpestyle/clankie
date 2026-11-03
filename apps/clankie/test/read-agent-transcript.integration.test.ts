import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLocalAgentHost } from "@clankie/agent-hosts";
import { afterEach, expect, test } from "vitest";
import type { HerdrFleet } from "../src/herdr-fleet.ts";
import { createRemoteHerdrRunner, routeHerdrFleets } from "../src/captain/herdr-fleet-runner.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import {
  createOperatorService,
  type CreateOperatorServiceContext,
} from "../src/captain/captain-operator-service.ts";
import { RuntimeTerminals } from "../src/captain/runtime-terminals.ts";
import { TRANSCRIPT_READ_DETAIL, TRANSCRIPT_READ_REFUSED } from "../src/captain/agent-transcript-read.ts";

const exec = promisify(execFile);

// #328: a Claude Code or Codex pane is read from that session's own transcript, so the owner's
// shell work in the same pane (a launch inside a longer block, a suspend with `fg`) never shows,
// on this Mac or over the linked-PC path. Real Herdr, the real local and remote runners, the
// real operator service and real transcript files; only `claude` and `codex` are stand-ins that
// write their native JSONL, report themselves to Herdr as the real harnesses do, then idle. The
// PC's ssh transport is stood in by running the same argv against this Herdr, and its transcript
// host is the confined local host over the same home.
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const standIn = (harness: "claude" | "codex") => `#!${process.execPath}
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
process.title = ${JSON.stringify(harness)};
const path = process.env.STAND_IN_TRANSCRIPT;
const session = process.env.STAND_IN_SESSION;
const record = (role, text, id) =>
  ${
    harness === "claude"
      ? `({ type: role === "user" ? "user" : "assistant", uuid: id, parentUuid: last,
          message: { role, content: role === "user" ? text : [{ type: "text", text }] } })`
      : `({ timestamp: new Date().toISOString(), type: "response_item",
          payload: { id, type: "message", role,
            content: [{ type: role === "user" ? "input_text" : "output_text", text }],
            ...(role === "user" ? { internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } } : {}) } })`
  };
let last = null;
const write = (role, text, id) => {
  appendFileSync(path, JSON.stringify(record(role, text, id)) + "\\n");
  last = id;
};
if (path) {
  mkdirSync(dirname(path), { recursive: true });
  write("user", "Fix issue 328", "u1");
  write("assistant", "${harness} transcript: reading the pane from its session", "a1");
}
// The agent and its session, as the harness's Herdr integration reports them.
const report = (state) =>
  execFileSync("herdr", ["pane", "report-agent", process.env.HERDR_PANE_ID, "--source",
    "herdr:${harness}", "--agent", "${harness}", "--state", state, "--agent-session-id", session]);
report("idle");
process.stdout.write("${harness} screen: ready\\n");
process.on("SIGCONT", () => {
  if (path) write("assistant", "${harness} transcript: back after fg", "a2");
  // The same process and session report again, as the harness's next hook would.
  report("idle");
  process.stdout.write("${harness} screen: back\\n");
});
setInterval(() => {}, 1 << 30);
`;

test("Claude Code and Codex panes read their own transcript, never the owner's shell work, locally and on a PC", async () => {
  // Short path: macOS socket limit.
  const root = await mkdtemp("/tmp/read-transcript-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  for (const directory of ["config", "bin", "work", "home/.claude/projects", "home/.codex/sessions"])
    await mkdir(join(root, directory), { recursive: true });
  await writeFile(
    join(root, "config/config.toml"),
    'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n[update]\nversion_check = false\nmanifest_check = false\n',
  );
  for (const harness of ["claude", "codex"] as const) {
    await writeFile(join(root, "bin", harness), standIn(harness));
    await chmod(join(root, "bin", harness), 0o755);
  }
  // Codex ids are UUIDv7 and its rollouts sit under their UTC creation date.
  const now = new Date();
  const stamp = now.getTime().toString(16).padStart(12, "0");
  const sessions = {
    claude: "0b3c8f2e-6f1d-4c59-9a7e-2f1d8c3b5a61",
    codex: `${stamp.slice(0, 8)}-${stamp.slice(8, 12)}-7222-8333-944455556666`,
  };
  const day = [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()]
    .map((part) => String(part).padStart(2, "0"))
    .join("/");
  const transcripts = {
    claude: join(home, ".claude/projects/-work", `${sessions.claude}.jsonl`),
    codex: join(home, ".codex/sessions", day, `rollout-2026-11-02T00-00-00-${sessions.codex}.jsonl`),
  };
  // This Mac's transcript lookup reads the same homes the stand-ins write.
  const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  process.env.CODEX_HOME = join(home, ".codex");
  cleanups.push(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_"))),
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    HOME: join(root, "work"),
    HERDR_SOCKET_PATH: join(root, "herdr.sock"),
    HERDR_CONFIG_PATH: join(root, "config/config.toml"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    SHELL: "/bin/sh",
  };
  const server = spawn("herdr", ["server"], { env, stdio: "ignore" });
  cleanups.push(async () => {
    await exec("herdr", ["server", "stop"], { env }).catch(() => server.kill("SIGKILL"));
  });
  await expect.poll(() => existsSync(env.HERDR_SOCKET_PATH!), { timeout: 10_000 }).toBe(true);
  const herdr = async (args: readonly string[]) =>
    (await exec("herdr", [...args], { env, timeout: 15_000 })).stdout;

  const local = createHerdrWatchRunner(() => true, herdr, undefined, { localCodexRecovery: false });
  const pc: HerdrFleet = { id: "pc", session: "default", ssh: { host: "pc", shell: "posix" } };
  const runner = routeHerdrFleets(
    local,
    new Map([
      [
        "pc",
        createRemoteHerdrRunner(pc, async (args) => herdr(args), {
          pollMs: 0,
          transcriptHost: createLocalAgentHost({ home, codexHomes: [join(home, ".codex")] }),
        }),
      ],
    ]),
  );
  const serve = createOperatorService({
    deps: {
      herdrAvailable: () => true,
      fleets: { list: [pc], run: () => herdr, remoteWorkspace: async () => false },
    },
    shutdown: new AbortController(),
    personas: { ready: async () => {} },
    settingsStore: {},
    terminals: new RuntimeTerminals({ defaultAvailable: () => false }),
    herdrRunner: runner,
    herdrWatches: { stoppedReason: async () => undefined },
    liveSeats: [],
  } as unknown as CreateOperatorServiceContext);
  const read = (terminalId: string) => serve({ op: "terminal_read", schemaVersion: 1, terminalId });
  const screen = (paneId: string) => runner.readPane!(paneId, "recent-unwrapped", "text");

  // The owner launches each agent inside a longer block, after printing a secret in the same pane.
  // By absolute path, so a real harness installed on this machine never starts instead.
  const launch = async (harness: "claude" | "codex", session: string, transcript: string, secret: string) => {
    const paneId = await runner.createTab!({ cwd: join(root, "work"), label: harness });
    await herdr([
      "pane",
      "run",
      paneId,
      `echo ${secret}; STAND_IN_SESSION=${session} STAND_IN_TRANSCRIPT=${transcript} ${join(root, "bin", harness)}`,
    ]);
    await expect
      .poll(
        async () => {
          const pane = await runner.get(paneId);
          return (
            pane.agent === harness &&
            pane.session !== undefined &&
            (await screen(paneId)).includes("screen: ready")
          );
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    // The block's earlier output really is on the pane's screen.
    expect(await screen(paneId)).toContain(secret);
    return { paneId, terminalId: (await runner.get(paneId)).terminalId };
  };

  for (const harness of ["claude", "codex"] as const) {
    const secret = `BLOCK-SECRET-${harness}`;
    const { paneId, terminalId } = await launch(harness, sessions[harness], transcripts[harness], secret);
    for (const id of [terminalId, `pc/${terminalId}`]) {
      const answer = await read(id);
      expect(answer).toMatchObject({
        status: "read",
        text: `› Fix issue 328\n${harness} transcript: reading the pane from its session`,
        detail: TRANSCRIPT_READ_DETAIL,
      });
      expect(JSON.stringify(answer)).not.toContain(secret);
      expect(JSON.stringify(answer)).not.toContain("screen:");
    }

    // Suspend it, do shell work in its pane, bring it back: same process, same session.
    await herdr(["pane", "send-keys", paneId, "ctrl+z"]);
    const agentIn = (paneId: string) =>
      runner.get(paneId).then(
        (pane) => pane.agent,
        () => "none",
      );
    // Stopped, it leaves the shell in front: the pane holds no live agent and is not read.
    await expect
      .poll(async () => ((await read(terminalId)) as { status: string }).status, { timeout: 10_000 })
      .toBe("unavailable");
    const fgSecret = `FG-SECRET-${harness}`;
    await herdr(["pane", "run", paneId, `echo ${fgSecret}`]);
    await expect.poll(() => screen(paneId), { timeout: 10_000 }).toContain(fgSecret);
    // While it is stopped the pane is the owner's shell, and nothing is read from it.
    for (const id of [terminalId, `pc/${terminalId}`]) {
      const answer = await read(id);
      expect(answer).toMatchObject({ status: "unavailable" });
      expect(JSON.stringify(answer)).not.toContain(fgSecret);
    }
    await herdr(["pane", "run", paneId, "fg"]);
    await expect
      .poll(
        async () => (await agentIn(paneId)) === harness && (await screen(paneId)).includes("screen: back"),
        { timeout: 15_000 },
      )
      .toBe(true);
    for (const id of [terminalId, `pc/${terminalId}`]) {
      // A PC's transcript read is served from a cache for up to two seconds.
      let answer: unknown;
      await expect
        .poll(
          async () => {
            answer = await read(id);
            return JSON.stringify(answer);
          },
          { timeout: 10_000 },
        )
        .toContain(`${harness} transcript: back after fg`);
      expect(answer).toMatchObject({ status: "read", detail: TRANSCRIPT_READ_DETAIL });
      expect(JSON.stringify(answer)).not.toContain(fgSecret);
      expect(JSON.stringify(answer)).not.toContain(secret);
    }
  }

  // A Claude Code pane whose transcript can't be found is refused, never read from its screen.
  const missing = await launch("claude", "5d2e7a10-3c4b-4f6e-8a9d-0b1c2d3e4f50", "", "BLOCK-SECRET-missing");
  for (const id of [missing.terminalId, `pc/${missing.terminalId}`]) {
    const answer = await read(id);
    expect(answer).toEqual({
      op: "terminal_read",
      schemaVersion: 1,
      terminalId: id,
      status: "unavailable",
      detail: TRANSCRIPT_READ_REFUSED,
    });
  }
}, 120_000);
