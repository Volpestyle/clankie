import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

/** Run a test agent as node, which reports its status (OSC 7501) and prints `lines`. */
function agentScript(lines: readonly string[], then: string): string {
  return [
    `for (const line of ${JSON.stringify(lines)}) process.stdout.write(line + "\\n");`,
    `process.stdout.write("\\x1b]7501;state=idle:app=claude-code\\x1b\\\\");`,
    then,
  ].join("\n");
}

beforeAll(async () => {
  if (hc === undefined || process.platform === "win32") return;
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

function sources(herdrCoreEnv: NodeJS.ProcessEnv = env): SessionSources {
  const serve = createOperatorService({
    shutdown: new AbortController(),
    deps: {},
    personas: { ready: async () => {} },
    settingsStore: {},
    herdrCore: createHerdrCore({ env: herdrCoreEnv }),
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
        harness: "claude-code",
        machine: "this Mac",
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

coreIt("lists nothing when no core runs, rather than failing", async () => {
  const listed = await sources({ ...env, HC_SESSION: `${session}-absent` }).list();
  expect(listed.sessions).toEqual([]);
  // Listing never starts a core.
  expect(existsSync(join(stateHome, "herdr-core", `${session}-absent`))).toBe(false);
});
