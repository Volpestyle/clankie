import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import {
  MachineJoinStatusSchema,
  MachineJoinLeaseSchema,
  machineJoinLeaseAad,
} from "@clankie/protocol/machine-join";
import { MachineJoins } from "../src/machine-joins.ts";
import { createMachineJoinRoutes } from "../src/machine-join-routes.ts";
import { machineJoinHash, machineJoinKey } from "../src/machine-join-crypto.ts";
import { openGatewayValue } from "../src/gateway-encryption.ts";
import { runJoinedMachineChannel, saveJoinedMachineCredential } from "../../tui/bin/joined-machine-client.ts";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { DeliveryFence } from "../src/captain/delivery-fence.ts";
import { createHireLayout, WORKSPACE_CREATE_TIMEOUT_MS } from "../src/captain/hire-layout.ts";
import { HerdrWatchStore, createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { HerdrFleetError, remoteHerdrCommand } from "../src/herdr-fleet.ts";
import { createRemoteHireReceipts } from "../src/remote-hire-receipts.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const exec = promisify(execFile);
const nativeIt = it.skipIf(process.platform !== "darwin" || process.env.HIRE_RECEIPT_NATIVE_TEST !== "1");
/** The fleet runner's default for one remote Herdr call. */
const REMOTE_DEFAULT_MS = 20_000;
/** The joined PC answered its workspace create after more than the 20 s default (VUH-2180). */

/** A PC that never answers the create within any timeout, and creates nothing. */
const PC_SILENT = Number.POSITIVE_INFINITY;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(pcCreateMs: number) {
  const home = await realpath(await mkdtemp("/tmp/hire-unsent-"));
  roots.push(home);
  const herdr = await isolatedHerdr(join(home, "logs"));
  // Explicit --session ignores HERDR_SOCKET_PATH; bind this fixture's default namespace.
  await mkdir(join(herdr.root, "config/herdr"), { recursive: true });
  await symlink(herdr.socketPath, join(herdr.root, "config/herdr/herdr.sock"));
  const env = {
    ...process.env,
    HOME: home,
    HERDR_SOCKET_PATH: herdr.socketPath,
    HERDR_CONFIG_PATH: join(herdr.root, "config/config.toml"),
    XDG_CONFIG_HOME: join(herdr.root, "config"),
    XDG_STATE_HOME: join(herdr.root, "state"),
    XDG_DATA_HOME: join(herdr.root, "data"),
    XDG_CACHE_HOME: join(herdr.root, "cache"),
    XDG_RUNTIME_DIR: join(herdr.root, "runtime"),
  };
  // One real authenticated, encrypted loopback machine join. The fixture's shell
  // executes only in this scratch HOME and Herdr namespace; no PC is contacted.
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
    const r = await fetch(origin + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
    expect(r.status).toBe(200);
    return r.json();
  };
  const code = randomBytes(32).toString("base64url"),
    claimSecret = randomBytes(32).toString("base64url");
  const ticket = await post("/v1/machine-joins/start", {
    name: "fixture remote machine",
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
  let refusedCreate = "";
  const commands: string[] = [];
  const channel = runJoinedMachineChannel(credential, {
    store,
    signal: abort.signal,
    intervalMs: 10,
    ports: {
      shell: async (command, directory, signal) => {
        commands.push(command);
        if (command === refusedCreate)
          return JSON.stringify({ error: "fixture workspace create timed out before creating a pane" });
        try {
          return JSON.stringify({
            stdout: (
              await exec("/bin/sh", ["-c", command], {
                env,
                cwd: directory,
                signal,
                timeout: 30_000,
                maxBuffer: 4 * 1024 * 1024,
              })
            ).stdout,
          });
        } catch (error) {
          const failure = error as { message: string; stderr?: string };
          return JSON.stringify({ error: failure.message, stderr: failure.stderr });
        }
      },
    },
  });
  const fleet = {
    id: "pc",
    session: "default",
    ssh: { host: "fixture-joined-host", shell: "posix" as const },
  };
  const remote = async (command: string) => {
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
  const herdrCli = async (args: readonly string[]) =>
    (await exec("herdr", ["--session", "default", ...args], { env, timeout: 10_000 })).stdout;
  const creates: (number | undefined)[] = [];
  /** A fleet runner over this host, with the PC's create latency modelled. */
  const run = async (args: readonly string[], _signal?: AbortSignal, timeoutMs?: number) => {
    if (args[0] === "workspace" && args[1] === "create") {
      creates.push(timeoutMs);
      const limit = timeoutMs ?? REMOTE_DEFAULT_MS;
      if (pcCreateMs > limit) {
        refusedCreate = remoteHerdrCommand(fleet, args);
        await remote(refusedCreate).catch(() => undefined);
        throw new HerdrFleetError(
          "timeout",
          `fleet pc: herdr workspace create timed out after ${String(limit)} ms`,
        );
      }
    }
    return await remote(remoteHerdrCommand(fleet, args));
  };
  const receipts = createRemoteHireReceipts({
    fleet: async () => fleet,
    shell: () => remote,
  });
  const watches = join(home, "watches.json");
  const effects: string[] = [];
  const denied = async (name: string): Promise<never> => {
    effects.push(name);
    throw new Error(`Unexpected ${name} after an unconfirmed workspace create`);
  };
  const layout = createHireLayout(run);
  const projects = ProjectsSettingsSchema.parse({
    projects: [{ id: "fixture", name: "Fixture", workerCap: 1 }],
  });
  const watchesStore = new HerdrWatchStore(watches, {
    projectHirePolicy: {
      settings: async () => projects,
      project: async () => "fixture",
      tools: async () => [],
      proof: async () => undefined,
    },
    remoteWorkspace: async () => true,
    remoteHireReceipts: receipts,
    nativeLaunchPolicy: { admit: async () => {} },
    // A briefed hire needs the PC's harness adapter. This PC never answers its workspace create,
    // so nothing past the create, the adapter included, may run.
    // A briefed work hire also reads the PC's plan usage first.
    workerAccountsReport: async () => ({
      machine: "pc",
      shell: "posix",
      observedAt: new Date().toISOString(),
      accounts: [
        {
          harness: "claude",
          label: "fixture",
          home,
          signedIn: true,
          usable: true,
          plan: "pro",
          headroom: 0.8,
          usage: {
            source: "claude-usage",
            observedAt: new Date().toISOString(),
            windows: [{ id: "week", label: "Week", usedPercent: 20 }],
          },
        },
      ],
    }),
    remoteSeatAdapters: () => [
      { harness: "claude", start: async () => denied("adapter start"), attach: async () => undefined },
    ],
    runner: {
      ...createHerdrWatchRunner(() => true, run),
      get: async () => denied("get"),
      resolveTerminal: async () => denied("resolveTerminal"),
      wait: async () => denied("wait"),
      createTab: (options) => layout(options),
      startAgent: async () => denied("startAgent"),
      runInPane: async () => denied("runInPane"),
    },
  });
  const authority = {
    owner: { conversationId: "global-default" },
    current: () => true,
    authorize: async () => true,
  };
  const hire = async (
    directory: string,
    freshIntent?: { readonly id: string; readonly afterReceiptId: string },
    brief?: string,
  ) => {
    await mkdir(directory, { recursive: true });
    return await watchesStore.spawnSeat(
      {
        schemaVersion: 1,
        title: "PC worker",
        projectId: "fixture",
        deliverable: "fixture-issue",
        effort: "low",
        effortReason: "Fixture only reaches a failed workspace create.",
        harness: "claude",
        fleet: "pc",
        workingDirectory: directory,
        ...(freshIntent === undefined
          ? {}
          : {
              freshIntent,
              effort: "low" as const,
              effortReason: "A fixture hire only needs to reach the PC's workspace create.",
            }),
      },
      undefined,
      brief,
      undefined,
      authority,
    );
  };
  const receipt = () => new DeliveryFence(`${watches}.hire-receipts.json`).entries().at(-1)!;
  const allocations = async () =>
    JSON.parse(await readFile(`${watches}.project-hires.json`, "utf8")).allocations as {
      id: string;
      gone: boolean;
      started: boolean;
    }[];
  const close = async () => {
    watchesStore.close();
    abort.abort();
    await channel;
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await herdr.close();
  };
  return {
    home,
    herdr,
    herdrCli,
    run,
    creates,
    store: watchesStore,
    hire,
    receipt,
    effects,
    allocations,
    close,
    commands,
    joins,
    credential,
  };
}

nativeIt(
  "a host-proven unsent remote project hire releases its allocation before a fresh intent, without replaying the original",
  async () => {
    const f = await fixture(PC_SILENT);
    try {
      const directory = join(f.home, "project-place");
      const first = await f.hire(directory, undefined, "Inspect the first fixture issue.");
      expect(first).toMatchObject({ outcome: "failed", reason: "start_unconfirmed" });
      expect(first.outcome === "failed" ? first.detail : "").toContain("workspace create timed out");
      const [, original] = f.receipt();
      expect(original).toMatchObject({ remoteLaunchCommitted: true, remoteCommandUnsent: true });
      const [allocation] = await f.allocations();
      expect(allocation).toMatchObject({ started: true, gone: false });
      const second = await f.hire(directory, undefined, "Inspect the first fixture issue.");
      expect(second).toMatchObject({ outcome: "failed", reason: "not_ready" });
      const detail = second.outcome === "failed" ? (second.detail ?? "") : "";
      expect(detail).toContain("is settled");
      const encoded = /freshIntent (\{.*?\})/u.exec(detail)?.[1];
      expect(encoded).toBeDefined();
      expect((await f.allocations()).find((a) => a.id === allocation!.id)).toMatchObject({ gone: true });
      expect(f.creates).toHaveLength(1);
      expect(f.effects).toEqual([]);
      const fresh = await f.hire(directory, JSON.parse(encoded!), "Inspect a distinct new fixture issue.");
      expect(fresh).toMatchObject({ outcome: "failed", reason: "start_unconfirmed" });
      expect(f.creates).toHaveLength(2);
      expect(f.receipt()[1].messageId).not.toBe(original.messageId);
      expect(f.effects).toEqual([]);
      expect(f.commands.length).toBeGreaterThan(3);
    } finally {
      await f.close();
    }
  },
  120_000,
);
