import { randomBytes, randomUUID } from "node:crypto";
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
import { createHireLayout } from "../src/captain/hire-layout.ts";
import { createHiring, type HiringContext } from "../src/captain/captain-hiring.ts";
import { PersonaStore } from "../src/captain/personas.ts";
import { HerdrWatchStore, createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { HerdrFleetError, remoteHerdrCommand, remoteProgramCommand } from "../src/herdr-fleet.ts";
import { createRemoteHireReceipts } from "../src/remote-hire-receipts.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const exec = promisify(execFile);
const nativeIt = it.skipIf(process.platform !== "darwin" || process.env.HIRE_RECEIPT_NATIVE_TEST !== "1");
/** The fleet runner's default for one remote Herdr call. */
const REMOTE_DEFAULT_MS = 20_000;
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
  const controls: {
    authorized: boolean;
    afterSeal?: () => Promise<void>;
    afterInventory?: () => Promise<void>;
    authorize?: () => Promise<void>;
    createGate?: Promise<void>;
    createEntered?: () => void;
  } = { authorized: true };
  const channel = runJoinedMachineChannel(credential, {
    store,
    signal: abort.signal,
    intervalMs: 10,
    ports: {
      shell: async (command, directory, signal) => {
        commands.push(command);
        if (command === refusedCreate) {
          controls.createEntered?.();
          await controls.createGate;
          return JSON.stringify({ error: "fixture workspace create timed out before creating a pane" });
        }
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
  const dispatch = async (command: string): Promise<string> => {
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
  const remote = async (command: string): Promise<string> => {
    if (command.length <= 8_000) return dispatch(command);
    // SSH supports a larger command line than the join shell. The fixture
    // transports long scripts in bounded authenticated chunks, preserving the
    // production join limit and running the original script on the host.
    const path = join(home, `host-script-${randomUUID()}.sh`);
    const encoded = Buffer.from(command).toString("base64");
    for (let offset = 0; offset < encoded.length; offset += 3_000) {
      const script =
        offset === 0
          ? "require('node:fs').writeFileSync(process.argv[1],Buffer.from(process.argv[2],'base64'),{flag:'wx',mode:0o600})"
          : "require('node:fs').appendFileSync(process.argv[1],Buffer.from(process.argv[2],'base64'))";
      await dispatch(
        remoteProgramCommand("posix", "node", ["-e", script, path, encoded.slice(offset, offset + 3_000)]),
      );
    }
    return dispatch(remoteProgramCommand("posix", "sh", [path]));
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
  const hostReceipts = createRemoteHireReceipts({
    fleet: async () => fleet,
    shell: () => remote,
  });
  const receipts = {
    ...hostReceipts,
    seal: async (...args: Parameters<typeof hostReceipts.seal>) => {
      const evidence = await hostReceipts.seal(...args);
      await controls.afterSeal?.();
      return evidence;
    },
  };
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
  const watchOptions: NonNullable<ConstructorParameters<typeof HerdrWatchStore>[1]> = {
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
      list: async (fleet) => {
        const inventory = await createHerdrWatchRunner(() => true, run).list!(fleet);
        await controls.afterInventory?.();
        return inventory;
      },
      get: async () => denied("get"),
      resolveTerminal: async () => denied("resolveTerminal"),
      wait: async () => denied("wait"),
      createTab: (options) => layout(options),
      startAgent: async () => denied("startAgent"),
      runInPane: async () => denied("runInPane"),
    },
  };
  let watchesStore = new HerdrWatchStore(watches, watchOptions);
  const restart = () => {
    watchesStore.close();
    watchesStore = new HerdrWatchStore(watches, watchOptions);
  };
  const authority = {
    owner: { conversationId: "global-default" },
    current: () => controls.authorized,
    authorize: async () => {
      await controls.authorize?.();
      return controls.authorized;
    },
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
    get store() {
      return watchesStore;
    },
    restart,
    outerHire: async (directory: string, brief: string) => {
      await settings.update((current) => ({ ...current, projects }));
      const hiring = createHiring({
        options: { stateDir: home, repoRoot: home },
        deps: { fleets: { shell: () => remote } },
        settings: () => settings.load(),
        settingsStore: settings,
        resolveHireProject: async () => "fixture",
        autonomy: { enabled: true },
        refreshFleets: async () => [fleet],
        herdrRunner: watchOptions.runner,
        herdrWatches: watchesStore,
        personas: new PersonaStore(home),
        namedLocal: [],
        remoteFleets: [fleet],
        liveSeats: [],
      } as unknown as HiringContext);
      return hiring.hireSeat(
        {
          schemaVersion: 1,
          title: "Outer fixture hire",
          projectId: "fixture",
          deliverable: "fixture-issue",
          harness: "claude",
          fleet: "pc",
          workingDirectory: directory,
          effort: "low",
          effortReason: "Fixture only reaches its workspace create.",
        },
        brief,
        authority,
      );
    },
    hire,
    receipt,
    effects,
    allocations,
    close,
    commands,
    joins,
    credential,
    controls,
    nativePath: `${watches}.hire-receipts.json`,
    allocationPath: `${watches}.project-hires.json`,
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
      await f.restart();
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

nativeIt(
  "a create that landed late keeps the original receipt and allocation held",
  async () => {
    const f = await fixture(PC_SILENT);
    try {
      const directory = join(f.home, "late-project-place");
      await f.hire(directory, undefined, "Inspect a late-create fixture issue.");
      const [, original] = f.receipt();
      await f.herdrCli(["workspace", "create", "--cwd", directory, "--label", "late", "--no-focus"]);
      await f.hire(directory, undefined, "Inspect a late-create fixture issue.");
      expect(f.receipt()[1].messageId).toBe(original.messageId);
      expect(new DeliveryFence(f.nativePath).settlement(original.messageId)).toBeUndefined();
      expect((await f.allocations())[0]).toMatchObject({ gone: false });
      expect(f.creates).toHaveLength(1);
      expect(f.effects).toEqual([]);
    } finally {
      await f.close();
    }
  },
  120_000,
);

nativeIt.each(["missing", "wrong-id", "wrong-key", "duplicate"] as const)(
  "an allocation with %s native receipt linkage stays held after the host seals the hire",
  async (mode) => {
    const f = await fixture(PC_SILENT);
    try {
      const directory = join(f.home, "unmatched-project-place");
      await f.hire(directory, undefined, "Inspect an unmatched fixture issue.");
      const [, original] = f.receipt();
      const state = JSON.parse(await readFile(f.allocationPath, "utf8"));
      const row = state.allocations[0];
      if (mode === "missing") delete row.nativeReceipt;
      if (mode === "wrong-id") row.nativeReceipt.id = randomUUID();
      if (mode === "wrong-key")
        row.nativeReceipt.key = JSON.stringify(["another-fleet", "claude", directory, "new"]);
      if (mode === "duplicate") state.allocations.push({ ...structuredClone(row), id: randomUUID() });
      await writeFile(f.allocationPath, JSON.stringify(state));
      await f.hire(directory, undefined, "Inspect an unmatched fixture issue.");
      expect(new DeliveryFence(f.nativePath).settlement(original.messageId)).toMatchObject({
        journal: "launch-committed-command-unsent",
      });
      expect((await f.allocations()).every((entry) => !entry.gone)).toBe(true);
      expect(f.store.hireUnresolved({ fleet: "pc", workingDirectory: directory, harness: "claude" })).toBe(
        true,
      );
      expect(f.creates).toHaveLength(1);
      expect(f.effects).toEqual([]);
    } finally {
      await f.close();
    }
  },
  120_000,
);

nativeIt(
  "revocation after the real host seal prevents receipt settlement and allocation release",
  async () => {
    const f = await fixture(PC_SILENT);
    try {
      const directory = join(f.home, "revoked-project-place");
      await f.hire(directory, undefined, "Inspect a revoked fixture issue.");
      const [, original] = f.receipt();
      f.controls.afterSeal = async () => {
        f.controls.authorized = false;
      };
      await f.hire(directory, undefined, "Inspect a revoked fixture issue.");
      expect(new DeliveryFence(f.nativePath).settlement(original.messageId)).toBeUndefined();
      expect(f.receipt()[1].messageId).toBe(original.messageId);
      expect((await f.allocations())[0]).toMatchObject({ gone: false });
      expect(f.creates).toHaveLength(1);
      expect(f.effects).toEqual([]);
    } finally {
      await f.close();
    }
  },
  120_000,
);

nativeIt(
  "an allocation changed during the release guard cannot be freed by a stale snapshot",
  async () => {
    const f = await fixture(PC_SILENT);
    try {
      const directory = join(f.home, "changed-project-place");
      await f.hire(directory, undefined, "Inspect a changed-allocation fixture issue.");
      const [, original] = f.receipt();
      let changed = false;
      f.controls.authorize = async () => {
        if (changed || !new DeliveryFence(f.nativePath).settlement(original.messageId)) return;
        changed = true;
        const state = JSON.parse(await readFile(f.allocationPath, "utf8"));
        state.allocations[0].request.title = "Concurrent allocation change";
        await writeFile(f.allocationPath, JSON.stringify(state));
      };
      await f.hire(directory, undefined, "Inspect a changed-allocation fixture issue.");
      expect(changed).toBe(true);
      expect((await f.allocations())[0]).toMatchObject({ gone: false });
      expect(f.creates).toHaveLength(1);
      expect(f.effects).toEqual([]);
    } finally {
      await f.close();
    }
  },
  120_000,
);

nativeIt(
  "the captain retires the proven-dead original before checkout fences and preserves the owner's dirty start folder",
  async () => {
    const f = await fixture(PC_SILENT);
    try {
      const origin = join(f.home, "origin.git"),
        directory = join(f.home, "checkout");
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
      );
      const git = (...args: string[]) => exec("git", args, { cwd: f.home, env });
      await git("init", "--bare", "--initial-branch=main", origin);
      await git("clone", origin, directory);
      await writeFile(join(directory, "base.txt"), "fixture base\n");
      await git("-C", directory, "add", "base.txt");
      await git(
        "-C",
        directory,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "base",
      );
      await git("-C", directory, "push", "origin", "main");
      await writeFile(join(directory, "owner-draft.txt"), "preserve this draft\n");
      const first = await f.hire(directory, undefined, "Inspect the original fixture issue.");
      expect(first).toMatchObject({ outcome: "failed", reason: "start_unconfirmed" });
      const [allocation] = await f.allocations();
      const second = await f.outerHire(directory, "Inspect a distinct next fixture issue.");
      expect(second, JSON.stringify(second)).toMatchObject({
        outcome: "failed",
        reason: "start_unconfirmed",
      });
      expect(second.outcome === "failed" ? second.detail : "").toContain("workspace create timed out");
      expect((await f.allocations()).find((entry) => entry.id === allocation!.id)).toMatchObject({
        gone: true,
      });
      expect(f.creates).toHaveLength(2);
      const nextDirectory = JSON.parse(f.receipt()[0])[2];
      expect(nextDirectory).not.toBe(directory);
      expect(await readFile(join(nextDirectory, "base.txt"), "utf8")).toBe("fixture base\n");
      expect(await readFile(join(directory, "owner-draft.txt"), "utf8")).toBe("preserve this draft\n");
      expect(f.effects).toEqual([]);
    } finally {
      await f.close();
    }
  },
  120_000,
);

nativeIt(
  "a still-starting original keeps its allocation even before the remote create answers",
  async () => {
    const f = await fixture(PC_SILENT);
    let release!: () => void;
    f.controls.createGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      f.controls.createEntered = resolve;
    });
    let first: ReturnType<typeof f.hire> | undefined;
    try {
      const directory = join(f.home, "starting-project-place");
      first = f.hire(directory, undefined, "Inspect a still-starting fixture issue.");
      await Promise.race([
        entered,
        first.then(() => {
          throw new Error("Original hire ended before entering the fixture's pending create");
        }),
      ]);
      const [, original] = f.receipt();
      const second = await f.hire(directory, undefined, "Inspect a still-starting fixture issue.");
      expect(second).toMatchObject({ outcome: "failed", reason: "start_unconfirmed" });
      expect(new DeliveryFence(f.nativePath).settlement(original.messageId)).toBeUndefined();
      expect((await f.allocations())[0]).toMatchObject({ gone: false });
      expect(f.creates).toHaveLength(1);
      release();
      expect(await first).toMatchObject({ outcome: "failed", reason: "start_unconfirmed" });
      expect(f.effects).toEqual([]);
    } finally {
      release();
      await first;
      await f.close();
    }
  },
  120_000,
);

nativeIt(
  "a possibly dispatched harness stays held even when the current host census has no pane",
  async () => {
    const f = await fixture(PC_SILENT);
    try {
      const directory = join(f.home, "possibly-starting-project-place");
      await f.hire(directory, undefined, "Inspect a possibly-starting fixture issue.");
      const [key, original] = f.receipt();
      const state = JSON.parse(await readFile(f.nativePath, "utf8"));
      delete state[key].remoteCommandUnsent;
      await writeFile(f.nativePath, JSON.stringify(state));
      f.restart();
      await f.hire(directory, undefined, "Inspect a possibly-starting fixture issue.");
      expect(new DeliveryFence(f.nativePath).settlement(original.messageId)).toBeUndefined();
      expect(f.receipt()[1].messageId).toBe(original.messageId);
      expect((await f.allocations())[0]).toMatchObject({ gone: false });
      expect(f.creates).toHaveLength(1);
      expect(f.effects).toEqual([]);
    } finally {
      await f.close();
    }
  },
  120_000,
);

nativeIt(
  "automatic retirement cannot release an allocation outside the resolved project",
  async () => {
    const f = await fixture(PC_SILENT);
    try {
      const directory = join(f.home, "different-project-place");
      await f.hire(directory, undefined, "Inspect a project-scoped fixture issue.");
      const [, original] = f.receipt();
      await f.store.retireUnsentRemoteAt(
        { fleet: "pc", workingDirectory: directory },
        async () => {},
        "other-project",
      );
      expect(new DeliveryFence(f.nativePath).settlement(original.messageId)).toBeDefined();
      expect((await f.allocations())[0]).toMatchObject({ gone: false });
      expect(f.creates).toHaveLength(1);
      expect(f.effects).toEqual([]);
    } finally {
      await f.close();
    }
  },
  120_000,
);

nativeIt(
  "a pane appearing after the host seal prevents automatic allocation release",
  async () => {
    const f = await fixture(PC_SILENT);
    try {
      const directory = join(f.home, "post-seal-pane-place");
      await f.hire(directory, undefined, "Inspect a post-seal fixture issue.");
      const [, original] = f.receipt();
      f.controls.afterSeal = async () => {
        await f.herdrCli([
          "workspace",
          "create",
          "--cwd",
          directory,
          "--label",
          "late-after-seal",
          "--no-focus",
        ]);
      };
      await f.hire(directory, undefined, "Inspect a post-seal fixture issue.");
      expect(new DeliveryFence(f.nativePath).settlement(original.messageId)).toBeDefined();
      expect((await f.allocations())[0]).toMatchObject({ gone: false });
      expect(f.creates).toHaveLength(1);
      expect(f.effects).toEqual([]);
    } finally {
      await f.close();
    }
  },
  120_000,
);

nativeIt(
  "a duplicate receipt link introduced during the release guard stays held under the allocation lock",
  async () => {
    const f = await fixture(PC_SILENT);
    try {
      const directory = join(f.home, "concurrent-duplicate-place");
      await f.hire(directory, undefined, "Inspect a concurrent-link fixture issue.");
      const [, original] = f.receipt();
      let duplicated = false;
      f.controls.authorize = async () => {
        if (duplicated || !new DeliveryFence(f.nativePath).settlement(original.messageId)) return;
        duplicated = true;
        const state = JSON.parse(await readFile(f.allocationPath, "utf8"));
        state.allocations.push({ ...structuredClone(state.allocations[0]), id: randomUUID() });
        await writeFile(f.allocationPath, JSON.stringify(state));
      };
      await f.hire(directory, undefined, "Inspect a concurrent-link fixture issue.");
      expect(duplicated).toBe(true);
      expect((await f.allocations()).every((entry) => !entry.gone)).toBe(true);
      expect(f.creates).toHaveLength(1);
      expect(f.effects).toEqual([]);
    } finally {
      await f.close();
    }
  },
  120_000,
);

nativeIt(
  "revocation during the final allocation census prevents the automatic write",
  async () => {
    const f = await fixture(PC_SILENT);
    try {
      const directory = join(f.home, "final-census-revocation-place");
      await f.hire(directory, undefined, "Inspect a final-census fixture issue.");
      const [, original] = f.receipt();
      let censuses = 0;
      f.controls.afterInventory = async () => {
        if (!new DeliveryFence(f.nativePath).settlement(original.messageId)) return;
        if (++censuses === 2) f.controls.authorized = false;
      };
      await f.hire(directory, undefined, "Inspect a final-census fixture issue.");
      expect(censuses).toBe(2);
      expect(f.controls.authorized).toBe(false);
      expect((await f.allocations())[0]).toMatchObject({ gone: false });
      expect(f.creates).toHaveLength(1);
      expect(f.effects).toEqual([]);
    } finally {
      await f.close();
    }
  },
  120_000,
);

nativeIt(
  "the allocation's persisted harness must match its sealed receipt when the next harness is unspecified",
  async () => {
    const f = await fixture(PC_SILENT);
    try {
      const directory = join(f.home, "allocation-harness-mismatch");
      await f.hire(directory, undefined, "Inspect a persisted-scope fixture issue.");
      const [, original] = f.receipt();
      const state = JSON.parse(await readFile(f.allocationPath, "utf8"));
      state.allocations[0].request.harness = "codex";
      await writeFile(f.allocationPath, JSON.stringify(state));
      await f.store.retireUnsentRemoteAt(
        { fleet: "pc", workingDirectory: directory },
        async () => {},
        "fixture",
      );
      expect(new DeliveryFence(f.nativePath).settlement(original.messageId)).toMatchObject({
        journal: "launch-committed-command-unsent",
      });
      expect((await f.allocations())[0]).toMatchObject({ gone: false });
      expect(f.creates).toHaveLength(1);
      expect(f.effects).toEqual([]);
    } finally {
      await f.close();
    }
  },
  120_000,
);

nativeIt(
  "unavailable allocation inventory after host settlement keeps the place held",
  async () => {
    const f = await fixture(PC_SILENT);
    try {
      const directory = join(f.home, "unavailable-allocation-inventory");
      await f.hire(directory, undefined, "Inspect an unavailable-inventory fixture issue.");
      const [, original] = f.receipt();
      f.controls.afterInventory = async () => {
        if (new DeliveryFence(f.nativePath).settlement(original.messageId))
          throw new Error("Fixture inventory unavailable");
      };
      await f.hire(directory, undefined, "Inspect an unavailable-inventory fixture issue.");
      expect(new DeliveryFence(f.nativePath).settlement(original.messageId)).toBeDefined();
      expect((await f.allocations())[0]).toMatchObject({ gone: false });
      expect(f.creates).toHaveLength(1);
      expect(f.effects).toEqual([]);
    } finally {
      await f.close();
    }
  },
  120_000,
);

nativeIt(
  "a fresh intent stays held on its own retry",
  async () => {
    const f = await fixture(PC_SILENT);
    try {
      const directory = join(f.home, "fresh-intent-retry-place");
      await f.hire(directory, undefined, "Inspect the original fresh-retry fixture issue.");
      const second = await f.hire(directory, undefined, "Inspect the original fresh-retry fixture issue.");
      const detail = second.outcome === "failed" ? (second.detail ?? "") : "";
      const encoded = /freshIntent (\{.*?\})/u.exec(detail)?.[1];
      expect(encoded).toBeDefined();
      const fresh = JSON.parse(encoded!);
      await f.hire(directory, fresh, "Inspect a distinct fresh-retry fixture issue.");
      const [, original] = f.receipt();
      await f.hire(directory, fresh, "Inspect a distinct fresh-retry fixture issue.");
      expect(new DeliveryFence(f.nativePath).settlement(original.messageId)).toBeUndefined();
      expect((await f.allocations()).at(-1)).toMatchObject({ gone: false });
      expect(f.creates).toHaveLength(2);
      expect(f.effects).toEqual([]);
    } finally {
      await f.close();
    }
  },
  120_000,
);
