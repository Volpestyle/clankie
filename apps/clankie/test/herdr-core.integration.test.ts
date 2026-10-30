import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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

async function run(...args: string[]): Promise<string> {
  return (await exec(hc!, args, { env, cwd })).stdout;
}

const coreIt = it.skipIf(hc === undefined || process.platform === "win32");

beforeAll(async () => {
  if (hc === undefined || process.platform === "win32") return;
  cwd = await mkdtemp(join(tmpdir(), "clankie-herdr-core-"));
  // An agent, as hc defines one: a program that reports its status (OSC 7501).
  await run(
    "run",
    "--bg",
    "--json",
    "--name",
    "agent",
    "--",
    "sh",
    "-c",
    "printf 'Reviewed x.rs: two bugs\\n'; printf '\\033]7501;state=idle:app=claude-code\\033\\\\'; exec sleep 600",
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
  // Returns once the agent has reported a status other than working.
  await run("wait", "agent");
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

coreIt("lists and reads the desktop app's agents, and never messages them", async () => {
  const layer = sources();
  const listed = await layer.list();
  // Agents only: the plain shell beside it isn't listed.
  expect(listed.sessions).toEqual([
    expect.objectContaining({
      id: "herdr-core:t1",
      source: "herdr-core",
      harness: "claude-code",
      machine: "this Mac",
      status: "idle",
      canMessage: false,
    }),
  ]);

  expect((await layer.read("herdr-core:t1", 20)).text).toContain("Reviewed x.rs: two bugs");
  // A shell isn't an agent, so it can't be read by its address either.
  await expect(layer.read("herdr-core:t2", 20)).rejects.toThrow(/isn't a running agent/u);

  await expect(layer.send("herdr-core:t1", "please also fix them")).rejects.toBeInstanceOf(SessionRefusal);
  // Nothing was typed into the agent's terminal.
  expect(await run("read", "agent")).not.toContain("please also fix them");
});

coreIt("lists nothing when no core runs, rather than failing", async () => {
  const listed = await sources({ ...env, HC_SESSION: `${session}-absent` }).list();
  expect(listed.sessions).toEqual([]);
  // Listing never starts a core.
  expect(existsSync(join(stateHome, "herdr-core", `${session}-absent`))).toBe(false);
});
