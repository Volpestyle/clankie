import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { SessionRefusal, SessionSources, createHerdrCoreSessionSource } from "@clankie/agent-hosts/sessions";
import {
  createOperatorService,
  type CreateOperatorServiceContext,
} from "../src/captain/captain-operator-service.ts";
import { createHerdrCore } from "../src/captain/herdr-core.ts";

// The Herdr desktop app's agents, end to end against a real herdr-core: the
// connector's session source, Clankie's operator ops, and the core's own
// socket. The test runs its own core session, so the owner's app and its
// agents are never touched.

const exec = promisify(execFile);
const hc = (process.env.PATH ?? "")
  .split(delimiter)
  .map((dir) => join(dir, "hc"))
  .concat(join(homedir(), ".local", "bin", "hc"))
  .find((path) => existsSync(path));
// Short: the session names the socket twice, and macOS caps a socket path at 103 bytes.
const session = `ck-${process.pid}`;
// Its own session, and none of a calling hc terminal's identity.
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries({ ...process.env, HC_SESSION: session }).filter(
    ([key]) => !["HC_SOCKET", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"].includes(key),
  ),
);
const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
let cwd = "";
let go = "";

async function run(...args: string[]): Promise<string> {
  return (await exec(hc!, args, { env, cwd })).stdout;
}

/** Polls until `check` holds, for a few seconds: hc reads a terminal's foreground about twice a second. */
async function until(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((done) => setTimeout(done, 100)))
    if (await check()) return;
  throw new Error("timed out");
}

const coreIt = it.skipIf(hc === undefined || process.platform === "win32");

/**
 * Run a test agent as node, which reports its status (OSC 7501) and prints `lines`. It reports a
 * harness read from its screen; Claude Code and Codex are read from their transcript (#530).
 */
function agentScript(lines: readonly string[], then: string): string {
  return [
    `for (const line of ${JSON.stringify(lines)}) process.stdout.write(line + "\\n");`,
    `process.stdout.write("\\x1b]7501;state=idle:app=opencode\\x1b\\\\");`,
    then,
  ].join("\n");
}

beforeAll(async () => {
  if (hc === undefined || process.platform === "win32") return;
  // A Claude Code session file names its process only against that pid's kernel birth (#530).
  await exec(process.execPath, [join(import.meta.dirname, "../../../scripts/build-fleet-proof.mjs")]);
  cwd = await mkdtemp(join(tmpdir(), "clankie-herdr-core-"));
  go = join(cwd, "go");
  // An agent, as hc defines one: a program that reports its status (OSC 7501). The shell
  // that started it printed the owner's own text first, then became the agent. Once `go`
  // exists, the agent prints its next line.
  await run(
    "run",
    "--bg",
    "--json",
    "--name",
    "agent",
    "--",
    "sh",
    "-c",
    'printf "before=secret\\n"; exec "$0" -e "$1"',
    process.execPath,
    agentScript(
      ["Reviewed x.rs: two bugs"],
      `const fs = require("node:fs");
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(go)})) return;
  clearInterval(timer);
  process.stdout.write("Fixed both bugs\\n");
}, 100);
setInterval(() => {}, 1 << 30);`,
    ),
  );
  // A plain shell beside it, which reports nothing.
  await run(
    "run",
    "--bg",
    "--json",
    "--name",
    "shell",
    "--",
    "sh",
    "-c",
    "printf 'secret=1\\n'; exec sleep 600",
  );
  // An agent that reported, exited back to its shell, and left the owner's text after it.
  // hc keeps the status it reported until the terminal's own program ends.
  await run(
    "run",
    "--bg",
    "--json",
    "--name",
    "exited",
    "--",
    "sh",
    "-c",
    '"$0" -e "$1"; printf "after=secret\\n"; exec sh',
    process.execPath,
    agentScript(["Done here"], "process.exit(0);"),
  );
  // Returns once the agent has reported a status other than working.
  await run("wait", "agent");
  // The exited agent's shell has printed the owner's text and is back in front.
  await until(async () => (await run("read", "exited")).includes("after=secret"));
});

afterAll(async () => {
  if (hc === undefined || process.platform === "win32") return;
  await run("server", "stop").catch(() => undefined);
  await rm(join(stateHome, "herdr-core", session), { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

function sources(
  herdrCoreEnv: NodeJS.ProcessEnv = env,
  leftoverStarter?: CreateOperatorServiceContext["leftoverStarter"],
): SessionSources {
  const serve = createOperatorService({
    shutdown: new AbortController(),
    deps: {},
    personas: { ready: async () => {} },
    settingsStore: {},
    herdrCore: createHerdrCore({ env: herdrCoreEnv }),
    ...(leftoverStarter === undefined ? {} : { leftoverStarter }),
  } as unknown as CreateOperatorServiceContext);
  return new SessionSources([createHerdrCoreSessionSource({ dispatch: (request) => serve(request) })]);
}

coreIt(
  "lists and reads the desktop app's agents, only their own output, and never messages them",
  async () => {
    const layer = sources();
    // Agents only: neither the plain shell nor the shell an agent exited back to is listed.
    await until(async () => (await layer.list()).sessions.length === 1);
    expect((await layer.list()).sessions).toEqual([
      expect.objectContaining({
        id: "herdr-core:t1",
        source: "herdr-core",
        harness: "opencode",
        // This Mac's agents carry its own name, as its fleet seats do (#262).
        machine: hostname().slice(0, 64),
        status: "idle",
        canMessage: false,
      }),
    ]);

    // The first read holds back everything the terminal held then, the shell's text and the
    // agent's own alike, and says so (ADR 0307).
    const first = await layer.read("herdr-core:t1", 50);
    expect(first.text).not.toContain("before=secret");
    expect(first.text).not.toContain("Reviewed x.rs");
    expect(first.note).toMatch(/Earlier screen hidden/u);
    // What the agent prints next is read; the earlier text stays held.
    await writeFile(go, "");
    let later = "";
    await until(async () => {
      later = (await layer.read("herdr-core:t1", 50)).text;
      return later.includes("Fixed both bugs");
    });
    expect(later).not.toContain("before=secret");
    expect(later).not.toContain("Reviewed x.rs");

    // A shell isn't an agent, so it can't be read by its address either.
    await expect(layer.read("herdr-core:t2", 20)).rejects.toThrow(/No coding agent is running/u);
    // Nor can an agent's terminal once it exited back to its shell, though hc keeps its status.
    await expect(layer.read("herdr-core:t3", 20)).rejects.toThrow(/No coding agent is running/u);

    await expect(layer.send("herdr-core:t1", "please also fix them")).rejects.toBeInstanceOf(SessionRefusal);
    // Nothing was typed into the agent's terminal.
    expect(await run("read", "agent")).not.toContain("please also fix them");
  },
);

coreIt(
  "reads an owner-started Claude Code or Codex agent from its own session transcript, never its screen (#530)",
  async () => {
    const homes = await realpath(await mkdtemp(join(tmpdir(), "clankie-core-sessions-")));
    const claudeHome = join(homes, "claude");
    const codexHome = join(homes, "codex");
    // This service's transcript lookup reads the homes the stand-ins write.
    const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    process.env.CODEX_HOME = codexHome;
    const started: string[] = [];
    try {
      // Each session's transcript, as its harness writes it.
      const now = new Date();
      const stamp = now.getTime().toString(16).padStart(12, "0");
      const claudeSession = "5c1d7e2a-30b4-4f6e-8a1c-9d2e4f6a8b0c";
      // A Codex id carries its day, which names the folder its rollout lives in.
      const codexSession = `${stamp.slice(0, 8)}-${stamp.slice(8, 12)}-7222-8333-944455556666`;
      const day = [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()]
        .map((part) => String(part).padStart(2, "0"))
        .join("/");
      const claudeTranscript = join(claudeHome, "projects", "-work", `${claudeSession}.jsonl`);
      const rollout = join(codexHome, "sessions", day, `rollout-2026-11-04T00-00-00-${codexSession}.jsonl`);
      await mkdir(dirname(claudeTranscript), { recursive: true });
      await mkdir(dirname(rollout), { recursive: true });
      await writeFile(
        claudeTranscript,
        [
          { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "Fix issue 530" } },
          {
            type: "assistant",
            uuid: "a1",
            parentUuid: "u1",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "claude: read from its session" }],
            },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      await writeFile(
        rollout,
        [
          ["user", "input_text", "Fix issue 530"],
          ["assistant", "output_text", "codex: read from its session"],
        ]
          .map(([role, type, text], index) =>
            JSON.stringify({
              timestamp: now.toISOString(),
              type: "response_item",
              payload: {
                id: `m${index}`,
                type: "message",
                role,
                content: [{ type, text }],
                ...(role === "user"
                  ? { internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } }
                  : {}),
              },
            }),
          )
          .join("\n") + "\n",
      );
      // A stand-in for each harness, started by the owner's shell after his own text. Claude Code
      // records its session under its pid with its start, as `ps -o lstart` prints it; Codex
      // holds its rollout open. Each then reports itself (OSC 7501) and prints a screen-only line.
      const standIn = join(homes, "stand-in.cjs");
      await writeFile(
        standIn,
        `const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const [harness, home, session, rollout] = process.argv.slice(2);
if (harness === "claude") {
  const procStart = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8" }).trim();
  fs.mkdirSync(home + "/sessions", { recursive: true });
  fs.writeFileSync(home + "/sessions/" + process.pid + ".json", JSON.stringify({ pid: process.pid, sessionId: session, procStart }));
} else globalThis.held = fs.openSync(rollout, "a");
process.stdout.write("screen-only=secret\\n");
process.stdout.write("\\x1b]7501;state=idle:app=" + (harness === "claude" ? "claude-code" : "codex") + "\\x1b\\\\");
setInterval(() => {}, 1 << 30);
`,
      );
      const start = async (name: string, ...args: string[]) => {
        const { address } = JSON.parse(
          await run(
            "run",
            "--bg",
            "--json",
            "--name",
            name,
            "--",
            "sh",
            "-c",
            'printf "owner=secret\\n"; exec "$0" "$@"',
            process.execPath,
            standIn,
            ...args,
          ),
        ) as { address: string };
        started.push(address);
        await run("wait", address);
        return `herdr-core:${address}`;
      };
      const claude = await start("owner-claude", "claude", claudeHome, claudeSession);
      const codex = await start("owner-codex", "codex", codexHome, codexSession, rollout);
      const layer = sources({ ...env, XDG_STATE_HOME: stateHome });
      // hc reads a terminal's foreground about twice a second; both are listed once it has.
      await until(async () => {
        const listed = (await layer.list()).sessions.map((session) => session.id);
        return listed.includes(claude) && listed.includes(codex);
      });

      for (const [id, reply] of [
        [claude, "claude: read from its session"],
        [codex, "codex: read from its session"],
      ] as const) {
        const read = await layer.read(id, 50);
        expect(read.text).toContain("› Fix issue 530");
        expect(read.text).toContain(reply);
        // Neither the owner's shell text nor anything only on its screen is read.
        expect(read.text).not.toContain("owner=secret");
        expect(read.text).not.toContain("screen-only=secret");
        expect(read.note).toMatch(/own session transcript, not its screen/u);
      }

      // A session file whose recorded start isn't this process's own (a reused pid) names
      // nothing, and the read is refused rather than shown from the screen.
      const recorded = (await readdir(join(claudeHome, "sessions"))).find((name) => name.endsWith(".json"))!;
      const file = join(claudeHome, "sessions", recorded);
      const original = JSON.parse(await readFile(file, "utf8")) as { procStart: string };
      await writeFile(file, JSON.stringify({ ...original, procStart: "Mon Jan  1 00:00:00 2024" }));
      await expect(layer.read(claude, 50)).rejects.toThrow(/own session transcript can't be read now/u);
    } finally {
      for (const address of started) await run("kill", address).catch(() => undefined);
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      await rm(homes, { recursive: true, force: true });
    }
  },
);

coreIt("lists nothing when no core runs, rather than failing", async () => {
  const listed = await sources({ ...env, HC_SESSION: `${session}-absent` }).list();
  expect(listed.sessions).toEqual([]);
  // Listing never starts a core.
  expect(existsSync(join(stateHome, "herdr-core", `${session}-absent`))).toBe(false);
});

coreIt(
  "lists a hire's terminal that finished as a leftover, with who started it, until it is removed",
  async () => {
    const finished = async (name: string, labels: readonly string[]) => {
      const { address } = JSON.parse(
        await run(
          "run",
          "--bg",
          "--json",
          "--name",
          name,
          ...labels.flatMap((label) => ["--label", label]),
          "--",
          "sh",
          "-c",
          "exit 0",
        ),
      ) as { address: string };
      await until(
        async () => (JSON.parse(await run("get", address)) as { state: string }).state === "finished",
      );
      return address;
    };
    const hire = await finished("hire", [
      "clankie.seat=clankie · Paperclip comparison",
      "clankie.agent=claude",
      "clankie.session=session-hire",
    ]);
    // The owner's own terminal that ended is his, and no leftover of Clankie's.
    await finished("owners", []);
    const asked: unknown[] = [];
    const layer = sources(env, (leftover) => {
      asked.push(leftover);
      return "Grok Bot";
    });
    const listed = (await layer.list()).sessions.filter((session) => session.status === "finished");
    expect(listed).toEqual([
      expect.objectContaining({
        id: `herdr-core:${hire}`,
        harness: "claude",
        status: "finished",
        startedBy: "Grok Bot",
        canMessage: false,
      }),
    ]);
    expect(asked).toEqual([{ seatId: `herdr-core/${hire}`, agent: "claude", session: "session-hire" }]);
    await run("rm", hire);
    expect((await layer.list()).sessions.some((session) => session.id === `herdr-core:${hire}`)).toBe(false);
  },
);
