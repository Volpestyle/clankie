import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, expect, it } from "vitest";
import { LocalCodexSeats } from "../src/local-codex-seats.ts";
import {
  createLocalCodexCatalogCoordinator,
  type LocalCodexCatalogResult,
} from "../src/captain/local-codex-catalog-coordinator.ts";
import { readLocalCodexRecords } from "../src/local-codex-records.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Owned protocol fixture did not settle");
}

/** Real Unix WebSocket RPC + private config/registry/journal files. Kernel observation is the sole fixture seam. */
async function fixture(pid = 42, paneId = "w1:p1") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-catalog-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "worker-codex", "seat-owned"),
    socketPath = join(root, "rpc.sock"),
    configPath = join(home, "config.toml"),
    recordsPath = join(root, "seats.json"),
    signalPath = join(root, "catalog-changed");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(configPath, "# owned copied worker config\n", { mode: 0o600 });
  const server = createServer(),
    ws = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
  cleanups.push(async () => {
    for (const client of ws.clients) client.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const binding = { runtime: "external" as const, session: "default", socketPath: join(root, "herdr.sock") };
  let currentBinding = binding,
    birth = "owned-server-birth",
    foreground = "original-tui",
    nativeOccupant: string | undefined;
  const registry = () =>
    new LocalCodexSeats(
      () => currentBinding,
      async () => birth,
      { path: recordsPath, observeOccupant: async () => nativeOccupant },
    );
  let seats = registry();
  const release = seats.register(pid, paneId);
  await release.bindSession!("root", `unix://${socketPath}`);
  nativeOccupant = readLocalCodexRecords(recordsPath)[0]!.nativeOccupantId;
  const calls: { method: string; params: Record<string, unknown> }[] = [],
    results: LocalCodexCatalogResult[] = [];
  let busy = false,
    childBusy = false,
    independent = false,
    catalogReady = true,
    loseWriteReply = false,
    loseReloadReply = false,
    busyAfterWrite = false,
    higherLayer = false;
  let configReads = 0,
    onConfigRead: ((count: number) => Promise<void>) | undefined,
    requestedThreadId: string | undefined,
    loadedRoot = "root";
  let tools: Record<string, unknown> = {
    message_clankie: {},
    message_clankie_status: {},
    clankie_tools: {},
    clankie_call: {},
  };
  let childExtraTools: Record<string, unknown> = {};
  let runtimeStatus = "connected";
  const version = async () =>
    createHash("sha256")
      .update(await readFile(configPath))
      .digest("hex");
  const envRevision = async () =>
    /CLANKIE_CATALOG_REVISION="([a-f0-9-]+)"/u.exec(await readFile(configPath, "utf8"))?.[1];
  const send = (socket: WebSocket, id: unknown, result: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ id, result }));
  };
  ws.on("connection", (socket) =>
    socket.on("message", (bytes) => {
      void (async () => {
        const message = object(JSON.parse(bytes.toString()));
        if (message.id === undefined) return;
        const method = String(message.method),
          params = object(message.params);
        calls.push({ method, params });
        if (method === "initialize")
          return send(socket, message.id, { userAgent: "owned-codex-protocol-fixture" });
        if (method === "thread/loaded/list")
          return send(socket, message.id, {
            data: [loadedRoot, "child", ...(independent ? ["unrelated"] : [])],
            nextCursor: null,
          });
        if (method === "thread/read")
          return send(socket, message.id, {
            thread: {
              id: params.threadId,
              cwd: root,
              ...(params.threadId === "child" ? { parentThreadId: loadedRoot } : {}),
              status: { type: (params.threadId === "root" ? busy : childBusy) ? "active" : "idle" },
            },
          });
        if (method === "config/read") {
          await onConfigRead?.(++configReads);
          const revision = await envRevision(),
            config = {
              mcp_servers: {
                clankie: {
                  enabled: true,
                  command: "clankie",
                  args: ["mcp", "--fleet"],
                  env: {
                    CLANKIE_CODEX_CATALOG_SIGNAL: signalPath,
                    ...(revision ? { CLANKIE_CATALOG_REVISION: revision } : {}),
                  },
                },
              },
            };
          return send(socket, message.id, {
            config,
            layers: [
              { name: { type: "user", file: configPath }, version: await version(), config },
              ...(higherLayer
                ? [
                    {
                      name: { type: "project" },
                      version: "project-version",
                      config: { mcp_servers: { clankie: { env: { CLANKIE_CATALOG_REVISION: "masked" } } } },
                    },
                  ]
                : []),
            ],
          });
        }
        if (method === "config/value/write") {
          expect(params.expectedVersion).toBe(await version());
          expect(params.filePath).toBe(configPath);
          expect(params.keyPath).toBe("mcp_servers.clankie.env.CLANKIE_CATALOG_REVISION");
          await writeFile(
            configPath,
            `# owned copied worker config\nCLANKIE_CATALOG_REVISION="${String(params.value)}"\n`,
            { mode: 0o600 },
          );
          if (busyAfterWrite) busy = true;
          if (loseWriteReply) return socket.close();
          return send(socket, message.id, {
            status: "ok",
            filePath: configPath,
            version: await version(),
            overriddenMetadata: null,
          });
        }
        if (method === "config/mcpServer/reload") {
          if (loseReloadReply) return socket.close();
          return send(socket, message.id, {});
        }
        if (method === "mcpServerStatus/list") {
          expect(["root", "child"]).toContain(params.threadId);
          expect(params.serverName).toBe("clankie");
          expect(params.detail).toBe("toolsAndAuthOnly");
          return send(socket, message.id, {
            data: [
              {
                name: "clankie",
                runtimeStatus,
                toolsError: catalogReady ? null : "still reconnecting",
                tools: params.threadId === "child" ? { ...tools, ...childExtraTools } : tools,
              },
            ],
            nextCursor: null,
          });
        }
        throw new Error(`Unexpected native RPC ${method}`);
      })().catch((error) => {
        if (socket.readyState === socket.OPEN)
          socket.send(
            JSON.stringify({
              id: object(JSON.parse(bytes.toString())).id,
              error: { code: -32603, message: String(error) },
            }),
          );
      });
    }),
  );
  const observeIdentity = async (candidate: ReturnType<LocalCodexSeats["catalogCandidates"]>[number]) => ({
    proof: { birth: candidate.start, socketPath, foreground },
    endpoint: `unix://${socketPath}`,
    ...(requestedThreadId === undefined ? {} : { requestedThreadId }),
    assertCurrent: () => {
      if (candidate.start !== birth) throw new Error("original_codex_server_birth_changed");
    },
  });
  const coordinators: ReturnType<typeof createLocalCodexCatalogCoordinator>[] = [];
  const coordinator = (auto = false, expectedTools?: () => readonly string[]) => {
    const value = createLocalCodexCatalogCoordinator({
      seats,
      ...(auto ? { revision: "deploy-one" } : {}),
      intervalMs: 10,
      onResult: (result) => results.push(result),
      ...(expectedTools === undefined ? {} : { expectedTools }),
      observeIdentity,
    });
    coordinators.push(value);
    return value;
  };
  cleanups.push(() => {
    for (const value of coordinators) value.close();
  });
  return {
    root,
    binding,
    observeIdentity,
    configPath,
    recordsPath,
    calls,
    results,
    release,
    coordinator,
    count: (method: string) => calls.filter((call) => call.method === method).length,
    setBusy: (value: boolean) => {
      busy = value;
    },
    setChildBusy: (value: boolean) => {
      childBusy = value;
    },
    setIndependent: () => {
      independent = true;
    },
    setMasked: () => {
      higherLayer = true;
    },
    setCatalogReady: (value: boolean) => {
      catalogReady = value;
    },
    setRuntimeStatus: (value: string) => {
      runtimeStatus = value;
    },
    setTools: (names: string[]) => {
      tools = Object.fromEntries(names.map((name) => [name, {}]));
    },
    setChildExtraTools: (names: string[]) => {
      childExtraTools = Object.fromEntries(names.map((name) => [name, {}]));
    },
    childActivity: () => {
      childBusy = true;
      for (const socket of ws.clients) {
        socket.send(
          JSON.stringify({
            method: "turn/started",
            params: { threadId: "child", turn: { id: "late-turn" } },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "thread/status/changed",
            params: { threadId: "child", status: { type: "active" } },
          }),
        );
      }
      childBusy = false;
      for (const socket of ws.clients)
        socket.send(
          JSON.stringify({
            method: "thread/status/changed",
            params: { threadId: "child", status: { type: "idle" } },
          }),
        );
    },
    loseReply: (kind: "write" | "reload") => {
      if (kind === "write") loseWriteReply = true;
      else loseReloadReply = true;
    },
    setBusyAfterWrite: () => {
      busyAfterWrite = true;
    },
    readBarrier: (value: (count: number) => Promise<void>) => {
      onConfigRead = value;
    },
    changeBirth: () => {
      birth = "reused-server-birth";
    },
    changeForeground: () => {
      foreground = "replacement-tui";
    },
    changeBinding: () => {
      currentBinding = { ...binding, session: "replacement" };
    },
    restartRegistry: () => {
      seats = registry();
    },
    makeLegacy: async () => {
      const state = JSON.parse(await readFile(recordsPath, "utf8"));
      delete state.seats[0].threadId;
      delete state.seats[0].endpoint;
      delete state.seats[0].catalogConfig;
      await writeFile(recordsPath, JSON.stringify(state), { mode: 0o600 });
      nativeOccupant = undefined;
      seats = registry();
    },
    setRequestedThread: (threadId: string) => {
      requestedThreadId = threadId;
    },
    setLoadedRoot: (threadId: string) => {
      loadedRoot = threadId;
    },
  };
}

it("refreshes original root and descendants once, retains native config provenance, and survives service restart without schema signals", async () => {
  const f = await fixture(),
    first = f.coordinator();
  expect(await first.refresh({ revision: "deploy-one" })).toMatchObject([
    { outcome: "refreshed", catalogs: [{ threadId: "child" }, { threadId: "root" }] },
  ]);
  expect(f.count("config/value/write")).toBe(1);
  expect(f.count("config/mcpServer/reload")).toBe(1);
  expect(readLocalCodexRecords(f.recordsPath)[0]!.catalogConfig?.filePath).toBe(f.configPath);
  expect(await first.refresh({ revision: "deploy-one" })).toMatchObject([{ outcome: "refreshed" }]);
  expect(f.count("config/value/write")).toBe(1);
  first.close();
  f.restartRegistry();
  expect(await f.coordinator().refresh({ revision: "deploy-two" })).toMatchObject([{ outcome: "refreshed" }]);
  expect(f.count("config/value/write")).toBe(2);
  expect(f.count("config/mcpServer/reload")).toBe(2);
  expect(
    f.calls.every((call) =>
      [
        "initialize",
        "thread/loaded/list",
        "thread/read",
        "config/read",
        "config/value/write",
        "config/mcpServer/reload",
        "mcpServerStatus/list",
      ].includes(call.method),
    ),
  ).toBe(true);
});

it("recovers a legacy registration only from the original native endpoint and loaded registered occupant digest", async () => {
  const f = await fixture();
  await f.makeLegacy();
  expect(readLocalCodexRecords(f.recordsPath)[0]).not.toHaveProperty("threadId");
  expect(await f.coordinator().refresh({ revision: "deploy-one" })).toMatchObject([
    { threadId: "root", outcome: "refreshed" },
  ]);
  expect(readLocalCodexRecords(f.recordsPath)[0]).toMatchObject({
    threadId: "root",
    catalogConfig: { filePath: f.configPath },
  });
  expect(f.count("config/value/write")).toBe(1);
  expect(f.count("config/mcpServer/reload")).toBe(1);
});

it.each(["digest", "requested", "independent"] as const)(
  "refuses legacy %s identity ambiguity without a native mutation",
  async (kind) => {
    const f = await fixture();
    await f.makeLegacy();
    if (kind === "digest") f.setLoadedRoot("replacement-thread");
    if (kind === "requested") f.setRequestedThread("replacement-thread");
    if (kind === "independent") f.setIndependent();
    expect(await f.coordinator().refresh({ revision: "deploy-one" })).toMatchObject([{ outcome: "failed" }]);
    expect(f.count("config/value/write")).toBe(0);
    expect(f.count("config/mcpServer/reload")).toBe(0);
  },
);

it("requires enabled fleet peer tools on the original root and every descendant", async () => {
  const f = await fixture();
  expect(
    await f
      .coordinator(false, () => [
        "message_clankie",
        "message_clankie_status",
        "clankie_tools",
        "clankie_call",
        "list_fleet_seats",
        "message_peer",
      ])
      .refresh({ revision: "deploy-one" }),
  ).toMatchObject([{ outcome: "failed", reason: "original_codex_catalog_unverified" }]);
  expect(f.count("config/value/write")).toBe(1);
  expect(f.count("config/mcpServer/reload")).toBe(1);
});

it("accepts the exact trusted projection when fleet tools are intentionally disabled", async () => {
  const f = await fixture();
  f.setTools(["message_clankie"]);
  expect(
    await f.coordinator(false, () => ["message_clankie"]).refresh({ revision: "deploy-one" }),
  ).toMatchObject([{ outcome: "refreshed" }]);
});

it("rejects an extra revoked peer tool on any original descendant", async () => {
  const f = await fixture();
  f.setChildExtraTools(["message_peer"]);
  expect(await f.coordinator().refresh({ revision: "deploy-one" })).toMatchObject([
    { outcome: "failed", reason: "original_codex_catalog_unverified" },
  ]);
});

it("keeps the original uncertain journal when a replacement same-thread TUI changes the observed proof", async () => {
  const f = await fixture(),
    first = f.coordinator();
  f.loseReply("write");
  expect(await first.refresh({ revision: "deploy-one" })).toMatchObject([{ outcome: "failed" }]);
  first.close();
  const directory = join(f.root, "codex-catalog-refresh"),
    names = await readdir(directory),
    journal = join(directory, names.find((name) => name.endsWith(".json"))!),
    original = await readFile(journal, "utf8");
  f.changeForeground();
  f.restartRegistry();
  const coordinator = f.coordinator();
  expect(await coordinator.refresh({ revision: "deploy-two" })).toMatchObject([
    { outcome: "failed", reason: "original_codex_durable_controller_proof_changed" },
  ]);
  coordinator.close();
  expect((await readdir(directory)).filter((name) => name.endsWith(".json"))).toEqual(names);
  expect(await readFile(journal, "utf8")).toBe(original);
  expect(f.count("config/value/write")).toBe(1);
  expect(f.count("config/mcpServer/reload")).toBe(0);
});

it("requires a connected native server even when the trusted expected projection is empty", async () => {
  const f = await fixture();
  f.setTools([]);
  f.setCatalogReady(false);
  expect(await f.coordinator(false, () => []).refresh({ revision: "deploy-one" })).toMatchObject([
    { outcome: "failed", reason: "original_codex_catalog_unverified" },
  ]);
});

it.each(["child-active", "child-active-idle", "birth", "foreground"] as const)(
  "refuses %s changes during the final awaited config read before a native write",
  async (kind) => {
    const f = await fixture(),
      coordinator = f.coordinator();
    f.readBarrier(async (count) => {
      if (count !== 2) return;
      if (kind === "child-active") f.setChildBusy(true);
      if (kind === "child-active-idle") f.childActivity();
      if (kind === "birth") f.changeBirth();
      if (kind === "foreground") f.changeForeground();
    });
    const result = await coordinator.refresh({ revision: "deploy-one" });
    coordinator.close();
    expect(result[0]!.outcome).toBe(kind.startsWith("child-") ? "skipped-busy" : "failed");
    expect(f.count("config/value/write")).toBe(0);
    expect(f.count("config/mcpServer/reload")).toBe(0);
  },
);

it("fences a descendant's active-to-idle activity after a confirmed write before the first reload", async () => {
  const f = await fixture(),
    coordinator = f.coordinator();
  f.readBarrier(async (count) => {
    if (count === 3) f.childActivity();
  });
  expect(await coordinator.refresh({ revision: "deploy-one" })).toMatchObject([{ outcome: "skipped-busy" }]);
  coordinator.close();
  expect(f.count("config/value/write")).toBe(1);
  expect(f.count("config/mcpServer/reload")).toBe(0);
});

it("allows read-only reconciliation under a held crash claim without deleting it or replaying native effects", async () => {
  const f = await fixture(),
    first = f.coordinator();
  expect(await first.refresh({ revision: "deploy-one" })).toMatchObject([{ outcome: "refreshed" }]);
  first.close();
  const directory = join(f.root, "codex-catalog-refresh"),
    journal = join(directory, (await readdir(directory)).find((name) => name.endsWith(".json"))!),
    claim = `${journal}.claim`,
    original = await readFile(journal, "utf8"),
    holder = JSON.stringify({ pid: 987654, nonce: "crashed-owner-fixture" });
  await writeFile(claim, holder, { mode: 0o600 });
  const coordinator = f.coordinator();
  expect(await coordinator.reconcile({ revision: "deploy-two" })).toMatchObject([
    {
      outcome: "failed",
      reason: "original_codex_refresh_claim_held_readonly_observed",
      catalogs: [{ threadId: "child" }, { threadId: "root" }],
    },
  ]);
  coordinator.close();
  expect(await readFile(claim, "utf8")).toBe(holder);
  expect(await readFile(journal, "utf8")).toBe(original);
  expect(f.count("config/value/write")).toBe(1);
  expect(f.count("config/mcpServer/reload")).toBe(1);
});

it("isolates a malformed signal from another registered controller in the same watcher cycle", async () => {
  const first = await fixture(),
    second = await fixture(43, "w1:p2"),
    seed = first.coordinator();
  expect(await seed.refresh({ revision: "deploy-one" })).toMatchObject([{ outcome: "refreshed" }]);
  seed.close();
  const firstRecord = readLocalCodexRecords(first.recordsPath)[0]!,
    secondRecord = { ...readLocalCodexRecords(second.recordsPath)[0]!, binding: first.binding };
  await writeFile(first.recordsPath, JSON.stringify({ version: 1, seats: [firstRecord, secondRecord] }), {
    mode: 0o600,
  });
  await writeFile(firstRecord.catalogConfig!.signalPath!, "malformed", { mode: 0o600 });
  const seats = new LocalCodexSeats(
    () => first.binding,
    async () => "owned-server-birth",
    { path: first.recordsPath, observeOccupant: async () => undefined },
  );
  const results: LocalCodexCatalogResult[] = [];
  const coordinator = createLocalCodexCatalogCoordinator({
    seats,
    revision: "deploy-two",
    intervalMs: 10,
    onResult: (result) => results.push(result),
    observeIdentity: (candidate) =>
      candidate.pid === 42 ? first.observeIdentity(candidate) : second.observeIdentity(candidate),
  });
  cleanups.push(() => coordinator.close());
  await until(() => results.some((result) => result.paneId === "w1:p2" && result.outcome === "refreshed"));
  coordinator.close();
  expect(results).toContainEqual(
    expect.objectContaining({ paneId: "w1:p1", reason: "invalid_codex_catalog_signal" }),
  );
  expect(second.count("config/value/write")).toBe(1);
  expect(second.count("config/mcpServer/reload")).toBe(1);
});

it("defers busy root or descendant and automatically refreshes when the original loaded scope becomes idle", async () => {
  const f = await fixture();
  f.setChildBusy(true);
  f.coordinator(true);
  await until(() => f.results.some((result) => result.outcome === "skipped-busy"));
  expect(f.count("config/value/write")).toBe(0);
  f.setChildBusy(false);
  await until(() => f.results.some((result) => result.outcome === "refreshed"));
  expect(f.count("config/value/write")).toBe(1);
  expect(f.count("config/mcpServer/reload")).toBe(1);
});

it("waits after a confirmed write if a turn begins, then sends the first reload without repeating the write", async () => {
  const f = await fixture();
  f.setBusyAfterWrite();
  const coordinator = f.coordinator();
  expect(await coordinator.refresh({ revision: "deploy-one" })).toMatchObject([{ outcome: "skipped-busy" }]);
  expect(f.count("config/value/write")).toBe(1);
  expect(f.count("config/mcpServer/reload")).toBe(0);
  f.setBusy(false);
  expect(await coordinator.refresh({ revision: "deploy-one" })).toMatchObject([{ outcome: "refreshed" }]);
  expect(f.count("config/value/write")).toBe(1);
  expect(f.count("config/mcpServer/reload")).toBe(1);
});

it.each(["write", "reload"] as const)(
  "retains an uncertain %s receipt across coordinator restart and never reissues either mutation",
  async (kind) => {
    const f = await fixture();
    f.loseReply(kind);
    const first = f.coordinator();
    expect(await first.refresh({ revision: "deploy-one" })).toMatchObject([{ outcome: "failed" }]);
    const writes = f.count("config/value/write"),
      reloads = f.count("config/mcpServer/reload");
    first.close();
    f.restartRegistry();
    expect(await f.coordinator().refresh({ revision: "deploy-two" })).toMatchObject([
      {
        outcome: "failed",
        reason: "original_codex_refresh_delivery_unconfirmed_readonly_reconciliation_required",
      },
    ]);
    expect(f.count("config/value/write")).toBe(writes);
    expect(f.count("config/mcpServer/reload")).toBe(reloads);
    expect(
      (await readdir(join(f.root, "codex-catalog-refresh"))).filter((path) => path.endsWith(".json")),
    ).toHaveLength(1);
  },
);

it("reconciles a confirmed reload through complete filtered catalogs without another mutation", async () => {
  const f = await fixture();
  f.setCatalogReady(false);
  const coordinator = f.coordinator();
  expect(await coordinator.refresh({ revision: "deploy-one" })).toMatchObject([
    { outcome: "failed", reason: "original_codex_catalog_unverified" },
  ]);
  f.setCatalogReady(true);
  expect(await coordinator.reconcile({ revision: "deploy-one" })).toMatchObject([{ outcome: "refreshed" }]);
  expect(f.count("config/value/write")).toBe(1);
  expect(f.count("config/mcpServer/reload")).toBe(1);
});

it("repairs a definitively failed startup after confirmed reload, retaining the failed generation", async () => {
  const f = await fixture(),
    first = f.coordinator();
  f.setRuntimeStatus("failed");
  expect(await first.refresh({ revision: "deploy-one" })).toMatchObject([
    {
      outcome: "failed",
      reason: "original_codex_catalog_unverified",
      detail: expect.stringContaining('"runtimeStatus":"failed"'),
    },
  ]);
  first.close();
  f.restartRegistry();
  const directory = join(f.root, "codex-catalog-refresh"),
    journal = join(directory, (await readdir(directory)).find((name) => name.endsWith(".json"))!),
    failed = JSON.parse(await readFile(journal, "utf8"));
  // The protocol fixture remains failed after this new reload too. The
  // actual binary integration proves successful reconnect and six-tool adoption.
  expect(await f.coordinator().refresh({ revision: "deploy-two" })).toMatchObject([{ outcome: "failed" }]);
  expect(f.count("config/value/write")).toBe(2);
  expect(f.count("config/mcpServer/reload")).toBe(2);
  expect(JSON.parse(await readFile(journal, "utf8")).envRevision).not.toBe(failed.envRevision);
  expect(
    JSON.parse(await readFile(`${journal}.${failed.envRevision}.confirmed-failure.json`, "utf8")),
  ).toEqual(failed);
});

it.each(["starting", "disconnected", "unknown", "connected"])(
  "keeps a confirmed unverified %s catalog read-only without definitive native startup failure",
  async (status) => {
    const f = await fixture(),
      coordinator = f.coordinator();
    f.setRuntimeStatus(status);
    f.setCatalogReady(false);
    expect(await coordinator.refresh({ revision: "deploy-one" })).toMatchObject([{ outcome: "failed" }]);
    expect(await coordinator.refresh({ revision: "deploy-two" })).toMatchObject([
      { outcome: "failed", reason: "original_codex_catalog_unverified" },
    ]);
    expect(f.count("config/value/write")).toBe(1);
    expect(f.count("config/mcpServer/reload")).toBe(1);
  },
);

it.each(["write", "reload"] as const)(
  "does not retry a lost %s acknowledgment even with definitive failed startup evidence",
  async (kind) => {
    const f = await fixture(),
      first = f.coordinator();
    f.setRuntimeStatus("failed");
    f.loseReply(kind);
    expect(await first.refresh({ revision: "deploy-one" })).toMatchObject([{ outcome: "failed" }]);
    first.close();
    f.restartRegistry();
    const writes = f.count("config/value/write"),
      reloads = f.count("config/mcpServer/reload");
    expect(await f.coordinator().refresh({ revision: "deploy-two" })).toMatchObject([
      {
        outcome: "failed",
        reason: "original_codex_refresh_delivery_unconfirmed_readonly_reconciliation_required",
      },
    ]);
    expect(f.count("config/value/write")).toBe(writes);
    expect(f.count("config/mcpServer/reload")).toBe(reloads);
    expect(
      (await readdir(join(f.root, "codex-catalog-refresh"))).filter((name) => name.endsWith(".json")),
    ).toHaveLength(1);
  },
);

it("serializes journal reconciliation and native effects across independent coordinator instances", async () => {
  const f = await fixture();
  let prepared = false,
    release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.readBarrier(async (count) => {
    if (count === 2) {
      prepared = true;
      await gate;
    }
  });
  const first = f.coordinator(),
    second = f.coordinator(),
    pending = first.refresh({ revision: "deploy-one" });
  await until(() => prepared);
  expect(await second.refresh({ revision: "deploy-one" })).toMatchObject([
    { outcome: "skipped-busy", reason: "original_codex_refresh_in_progress" },
  ]);
  second.close();
  release!();
  expect(await pending).toMatchObject([{ outcome: "refreshed" }]);
  first.close();
  expect(await f.coordinator().reconcile({ revision: "deploy-one" })).toMatchObject([
    { outcome: "refreshed" },
  ]);
  expect(f.count("config/value/write")).toBe(1);
  expect(f.count("config/mcpServer/reload")).toBe(1);
});

it("retains a queued operator's authority while a service refresh is already in progress", async () => {
  const f = await fixture();
  let prepared = false,
    current = true,
    release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.readBarrier(async (count) => {
    if (count === 2) {
      prepared = true;
      await gate;
    }
  });
  const coordinator = f.coordinator(),
    pending = coordinator.refresh({ revision: "deploy-one" });
  await until(() => prepared);
  expect(
    await coordinator.refresh({
      revision: "manual-two",
      current: () => current,
      beforeDispatch: async () => {
        if (!current) throw new Error("operator revoked");
      },
    }),
  ).toMatchObject([{ outcome: "skipped-busy" }]);
  current = false;
  release!();
  expect(await pending).toMatchObject([{ outcome: "refreshed" }]);
  await until(() =>
    f.results.some(
      (result) =>
        result.revision === "manual-two" && result.reason === "codex_refresh_operator_authority_changed",
    ),
  );
  expect(f.count("config/value/write")).toBe(1);
  expect(f.count("config/mcpServer/reload")).toBe(1);
});

it.each(["independent", "masked", "birth", "binding", "release"] as const)(
  "refuses changed %s proof before mutation",
  async (kind) => {
    const f = await fixture();
    if (kind === "independent") f.setIndependent();
    if (kind === "masked") f.setMasked();
    if (kind === "birth") f.changeBirth();
    if (kind === "binding") f.changeBinding();
    if (kind === "release")
      f.readBarrier(async () => {
        f.release();
      });
    const result = await f.coordinator().refresh({ revision: "deploy-one" });
    expect(result[0]!.outcome).toBe("failed");
    expect(f.count("config/value/write")).toBe(0);
    expect(f.count("config/mcpServer/reload")).toBe(0);
  },
);

it("rechecks operator authority after preparation and carries it through a deferred busy request", async () => {
  const f = await fixture();
  f.setBusy(true);
  const coordinator = f.coordinator();
  let current = true,
    checks = 0;
  const request = {
    revision: "manual-one",
    current: () => current,
    beforeDispatch: async () => {
      checks++;
      if (!current) throw new Error("revoked private operator token");
    },
  };
  expect(await coordinator.refresh(request)).toMatchObject([{ outcome: "skipped-busy" }]);
  current = false;
  f.setBusy(false);
  await until(() => f.results.some((result) => result.reason === "codex_refresh_operator_authority_changed"));
  expect(checks).toBeGreaterThan(0);
  expect(f.count("config/value/write")).toBe(0);
  expect(f.count("config/mcpServer/reload")).toBe(0);
});

it("never resumes an operator's confirmed write through an unguarded service lane", async () => {
  const f = await fixture(),
    coordinator = f.coordinator();
  let checks = 0;
  expect(
    await coordinator.refresh({
      revision: "manual-one",
      current: () => true,
      beforeDispatch: async () => {
        if (++checks === 2) throw new Error("operator revoked");
      },
    }),
  ).toMatchObject([{ outcome: "failed", reason: "codex_refresh_operator_authority_changed" }]);
  expect(f.count("config/value/write")).toBe(1);
  expect(f.count("config/mcpServer/reload")).toBe(0);
  expect(await coordinator.refresh({ revision: "service-two" })).toMatchObject([
    { outcome: "failed", reason: "original_codex_operator_refresh_requires_current_operator" },
  ]);
  expect(f.count("config/value/write")).toBe(1);
  expect(f.count("config/mcpServer/reload")).toBe(0);
  expect(
    await coordinator.refresh({
      revision: "manual-one",
      current: () => true,
      beforeDispatch: async () => {},
    }),
  ).toMatchObject([{ outcome: "refreshed" }]);
  expect(f.count("config/value/write")).toBe(1);
  expect(f.count("config/mcpServer/reload")).toBe(1);
});
