import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { FileCredentialStore } from "@clankie/credential-broker";
import {
  MachineJoinLeaseSchema,
  MachineJoinStatusSchema,
  machineJoinLeaseAad,
} from "@clankie/protocol/machine-join";
import { SettingsStore } from "@clankie/settings";
import {
  runJoinedMachineChannel,
  saveJoinedMachineCredential,
} from "../../../tui/bin/joined-machine-client.ts";
import { openGatewayValue } from "../../src/gateway-encryption.ts";
import { machineJoinHash, machineJoinKey } from "../../src/machine-join-crypto.ts";
import { createMachineJoinRoutes } from "../../src/machine-join-routes.ts";
import { MachineJoins } from "../../src/machine-joins.ts";
import {
  remoteHerdrCommand,
  type FleetShellRun,
  type HerdrFleet,
  type HerdrFleetRun,
} from "../../src/herdr-fleet.ts";
import { isolatedHerdr } from "./local-fleet-proof/herdr-fixture.ts";

const exec = promisify(execFile);

/**
 * A linked machine in scratch: one real authenticated, encrypted loopback machine
 * join into an isolated Herdr. Its `codex` is a stand-in that records each queue
 * call. Commands run only in this scratch HOME and Herdr namespace; no PC is contacted.
 */
export async function loopbackJoinedMachine() {
  const home = await realpath(await mkdtemp("/tmp/linked-seat-"));
  const herdr = await isolatedHerdr(join(home, "logs"));
  // Explicit --session ignores HERDR_SOCKET_PATH; bind this fixture's default namespace.
  await mkdir(join(herdr.root, "config/herdr"), { recursive: true });
  await symlink(herdr.socketPath, join(herdr.root, "config/herdr/herdr.sock"));
  const bin = join(home, "bin");
  const queueLog = join(home, "codex-queue.jsonl");
  const nextSession = join(home, "codex-next-session");
  await mkdir(bin);
  // Herdr lists a pane as an agent only while a process of that name reports it, so
  // the stand-in is both: `codex SESSION` holds the pane, `codex queue ...` records.
  // Herdr takes a session change only from inside the pane, as a real /clear makes it.
  await writeFile(
    join(bin, "codex"),
    `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, rmSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
let seq = 0;
const report = (session) => execFileSync("herdr", ["pane", "report-agent", process.env.HERDR_PANE_ID,
  "--source", "herdr:codex", "--agent", "codex", "--state", "idle", "--seq", String(++seq),
  "--agent-session-id", session]);
if (argv[0] === "queue") appendFileSync(${JSON.stringify(queueLog)}, JSON.stringify(argv) + "\\n");
else {
  report(argv[0]);
  setInterval(() => {
    if (!existsSync(${JSON.stringify(nextSession)})) return;
    const session = readFileSync(${JSON.stringify(nextSession)}, "utf8");
    rmSync(${JSON.stringify(nextSession)});
    execFileSync("herdr", ["pane", "report-agent-session", process.env.HERDR_PANE_ID, "--source", "herdr:codex",
      "--agent", "codex", "--seq", String(++seq), "--session-start-source", "clear", "--agent-session-id", session]);
  }, 50);
}
`,
  );
  await chmod(join(bin, "codex"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: home,
    HERDR_SOCKET_PATH: herdr.socketPath,
    HERDR_CONFIG_PATH: join(herdr.root, "config/config.toml"),
    XDG_CONFIG_HOME: join(herdr.root, "config"),
    XDG_STATE_HOME: join(herdr.root, "state"),
    XDG_DATA_HOME: join(herdr.root, "data"),
    XDG_CACHE_HOME: join(herdr.root, "cache"),
    XDG_RUNTIME_DIR: join(herdr.root, "runtime"),
  };
  const settings = new SettingsStore(join(home, "settings.json"));
  const secrets = new FileCredentialStore(join(home, "home-secrets.json"));
  const store = new FileCredentialStore(join(home, "host-secrets.json"));
  const joins = new MachineJoins({ settings, secrets, directory: join(home, "joins") });
  const app = new Hono().route(
    "/h/fixture",
    createMachineJoinRoutes(joins, async (request) =>
      request.headers.get("authorization") === "Bearer fixture-owner" ? true : "authentication_required",
    ),
  );
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("fixture_address_missing");
  const origin = `http://127.0.0.1:${address.port}/h/fixture`;
  const post = async (path: string, body: unknown, bearer?: string) => {
    const reply = await fetch(origin + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (reply.status !== 200) throw Error(`fixture_join_${path}_${String(reply.status)}`);
    return reply.json();
  };
  const code = randomBytes(32).toString("base64url"),
    claimSecret = randomBytes(32).toString("base64url");
  const ticket = await post("/v1/machine-joins/start", {
    name: "fixture linked machine",
    platform: "darwin",
    directories: [home],
    claimSecret,
    approvalHash: machineJoinHash(code),
  });
  await post(
    "/v1/machine-joins/approve",
    { code, accessLevel: "shell", directories: [home] },
    "fixture-owner",
  );
  const approved = MachineJoinStatusSchema.parse(
    await post("/v1/machine-joins/status", { joinId: ticket.joinId }, claimSecret),
  );
  if (approved.state !== "approved") throw Error("fixture_approval_missing");
  const credential = {
    origin,
    localDirectories: [home],
    lease: MachineJoinLeaseSchema.parse(
      JSON.parse(
        openGatewayValue(machineJoinKey(code), approved.sealedLease, machineJoinLeaseAad(ticket.joinId)),
      ),
    ),
  };
  await saveJoinedMachineCredential(store, credential);
  const abort = new AbortController();
  const channel = runJoinedMachineChannel(credential, {
    store,
    signal: abort.signal,
    intervalMs: 10,
    ports: {
      shell: async (command, directory, signal) => {
        try {
          const { stdout } = await exec("/bin/sh", ["-c", command], {
            env,
            cwd: directory,
            signal,
            timeout: 30_000,
            maxBuffer: 4 * 1024 * 1024,
          });
          return JSON.stringify({ stdout });
        } catch (error) {
          const failure = error as { message: string; stderr?: string };
          return JSON.stringify({ error: failure.message, stderr: failure.stderr });
        }
      },
    },
  });
  const fleet: HerdrFleet = {
    id: "pc",
    session: "default",
    ssh: { host: "fixture-joined-host", shell: "posix" },
  };
  const shell: FleetShellRun = async (command) => {
    const result = await joins.request(
      credential.lease.machineId,
      { kind: "shell", directory: home, command },
      40_000,
    );
    if (!result.ok) throw Error(result.error);
    const value = JSON.parse(result.output ?? "{}");
    if (value.error) throw Object.assign(Error(value.error), { stderr: value.stderr });
    return value.stdout ?? "";
  };
  const run: HerdrFleetRun = (args) => shell(remoteHerdrCommand(fleet, args));
  const herdrCli = async (args: readonly string[]) =>
    (await exec("herdr", ["--session", "default", ...args], { env, timeout: 10_000 })).stdout;
  return {
    home,
    fleet,
    run,
    shell,
    herdrCli,
    /** The pane's own process moves to a new session, as a real /clear does. */
    switchSession: (session: string) => writeFile(nextSession, session),
    /** Every `codex` call on the machine, as its argv. */
    codexCalls: async () =>
      (await readFile(queueLog, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    close: async () => {
      abort.abort();
      await channel.catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await herdr.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
