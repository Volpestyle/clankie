import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import {
  FileCredentialStore,
  LINEAR_API_PROVIDER_ID,
  type ProviderAccount,
} from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker, type LocalTrackerOptions, type TrackerReadSnapshot } from "@clankie/work-items";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, expect, it } from "vitest";
import type { LocalFleetIdentity } from "../src/local-fleet-link.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { createAccounts } from "../src/accounts.ts";
import { createLinearApiTracker } from "../src/linear-api-tracker.ts";
import { createLinearApiProvider, DOCUMENT_ID, ISSUE_ID } from "./fixtures/linear-api-provider.ts";

const SHORT_REQUEST_TIMEOUT_MS = 500;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function listen(fetch: (request: Request) => Promise<Response>) {
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing worker receipt fixture address");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** Real worker/host/SDK HTTP path; the isolated tracker owns one controlled issue. */
async function fixture(
  options: {
    local?: boolean;
    api?: boolean;
    manual?: boolean;
    requestTimeoutMs?: number;
    /** Supplies an admitted native session; its occupant can change like a relaunched harness. */
    native?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "clankie-worker-call-receipts-"));
  const admitted = gate();
  const release = gate();
  const observed = gate();
  const effects: Record<string, unknown>[] = [];
  const providerSessions = new Map<
    string,
    { server: Server; transport: WebStandardStreamableHTTPServerTransport }
  >();
  const provider = await listen(async (request) => {
    if (request.headers.get("authorization") !== "Bearer fixture-provider-secret")
      return new Response(null, { status: 401 });
    const id = request.headers.get("mcp-session-id");
    if (id) {
      const session = providerSessions.get(id);
      return session
        ? session.transport.handleRequest(request)
        : Response.json({ error: "unknown_session" }, { status: 404 });
    }
    const server = new Server(
      { name: "receipt-tracker-fixture", version: "1" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "save_issue",
          description: "Update the isolated fixture issue state.",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" }, state: { type: "string" } },
            required: ["id", "state"],
          },
        },
        { name: "read_large", inputSchema: { type: "object", properties: {} } },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      if (call.params.name === "read_large") {
        admitted.release();
        await release.promise;
        return { content: [{ type: "text", text: "x".repeat(60_000) }], isError: false };
      }
      expect(call.params.name).toBe("save_issue");
      const args = call.params.arguments ?? {};
      const issue = {
        id: String(args.id),
        status: String(args.state),
        description: "Saved fixture description ".repeat(3_000),
        url: "https://linear.app/fixture/issue/VUH-FIXTURE",
      };
      effects.push(issue);
      admitted.release();
      await release.promise;
      return { content: [{ type: "text", text: JSON.stringify(issue) }], isError: false };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
    });
    await server.connect(transport as unknown as Transport);
    const response = await transport.handleRequest(request);
    if (transport.sessionId) providerSessions.set(transport.sessionId, { server, transport });
    return response;
  });
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    fleet: { ...current.fleet, tools: "connected" },
    mcp: {
      ...current.mcp,
      servers: options.local
        ? []
        : [
            {
              id: "linear",
              transport: "http",
              url: provider.url,
              args: [],
              lane: "operator",
              credential: "linear",
              initialTools: [],
              enabled: true,
            },
          ],
    },
  }));
  const account: ProviderAccount = {
    provider: "linear",
    connectionId: randomUUID(),
    userId: randomUUID(),
    workspaceId: randomUUID(),
    name: "Fixture app",
    actor: "app",
    workspaceName: "Receipt fixture",
    verifiedAt: new Date().toISOString(),
  };
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const apiProvider = options.api ? await createLinearApiProvider() : undefined;
  if (apiProvider) {
    const accounts = createAccounts({
      store: credentials,
      apps: async () => ({
        github: {},
        linear: {
          clientId: "registered-client",
          redirectUri: "https://gateway.test/account/connections/callback",
        },
      }),
      fetch: apiProvider.fetch,
    });
    const start = await accounts.startLinear();
    if (!start.ok) throw new Error("Missing API receipt OAuth flow");
    expect((await accounts.completeLinear(start.flowId, "good-code")).ok).toBe(true);
  } else if (!options.local) {
    await credentials.set("linear", { type: "api", key: "fixture-provider-secret", account });
  }
  const localTracker = options.local
    ? createLocalTracker({ directory: join(root, "local-tracker") })
    : undefined;
  let routedRepo: string | undefined;
  let routeLookups = 0;
  let failRouteLookup: number | undefined;
  // Runs once after the host's pre-lock READ fence, just before the backend takes its lock.
  let beforeLock: (() => void) | undefined;
  const takeBeforeLock = () => {
    const hook = beforeLock;
    beforeLock = undefined;
    hook?.();
  };
  const host = createMcpHost({
    credentials,
    settings,
    curated: [],
    ...(localTracker
      ? {
          localTracker: {
            ...localTracker,
            call: (name, args, publication) => {
              if (publication?.beforeRead) takeBeforeLock();
              return localTracker.call(name, args, publication);
            },
            withReadSnapshot: (snapshot, apply) => {
              takeBeforeLock();
              return localTracker.withReadSnapshot(snapshot, apply);
            },
          },
          trackerIdentity: join(root, "local-tracker"),
          trackerRepoForWorker: async (_principalId, fence) => {
            if (++routeLookups === failRouteLookup) throw new Error("Fixture route lookup failed");
            const repo = routedRepo;
            fence?.(() => {
              if (routedRepo !== repo) throw new Error("The worker's tracker route changed");
            });
            return repo;
          },
        }
      : {}),
    ...(apiProvider
      ? {
          linearApiTracker: createLinearApiTracker({ credentials, fetch: apiProvider.fetch }),
          linearFetch: apiProvider.fetch,
        }
      : {}),
    logger: { info() {}, warn() {} },
    observeCall: () => observed.release(),
  });
  let valid = true;
  let authenticationFailure: Error | undefined;
  let heldFence: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | undefined;
  let heldCommit:
    | { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate>; settled: ReturnType<typeof gate> }
    | undefined;
  const hostResults: Awaited<ReturnType<typeof host.call>>[] = [];
  // Lost reply: the real host settles later, as after a caller timeout.
  let holdNextSettlement = false;
  let heldSettlement: (() => void) | undefined;
  const workerOptions = {
    directory: join(root, "grants"),
    credentials,
    host: options.manual
      ? {
          ...host,
          // Pause the real host after async admission, before its final account read
          // and synchronous dispatch check. Neither admission nor the provider is mocked.
          call: async (input: Parameters<typeof host.call>[0]) => {
            const held = heldCommit;
            heldCommit = undefined;
            const result = await host.call({
              ...input,
              fence: async () => {
                const commit = await input.fence?.();
                if (held) {
                  held.entered.release();
                  await held.release.promise;
                }
                return commit;
              },
            });
            hostResults.push(result);
            held?.settled.release();
            return result;
          },
        }
      : options.local
        ? {
            ...host,
            call: async (input: Parameters<typeof host.call>[0]) => {
              if (!holdNextSettlement) return host.call(input);
              holdNextSettlement = false;
              let intercepted!: () => void;
              const stashed = new Promise<void>((resolve) => (intercepted = resolve));
              const real = host.call({
                ...input,
                onSettled: (result, observation) => {
                  heldSettlement = () => input.onSettled?.(result, observation);
                  intercepted();
                },
              });
              // The real host settled after admission; this caller never receives that reply.
              await Promise.race([stashed, real]);
              return {
                outcome: "refused" as const,
                reason: "server_unavailable" as const,
                possiblyDispatched: true,
                detail: "Fixture reply lost after admission",
              };
            },
          }
        : host,
    // Receipt/authority tests use the production deadline, not a latency assertion.
    // Only tests whose contract is expiry opt into a short budget.
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    fleetTools: async () => (await settings.load()).fleet.tools,
    fleetToolsSnapshot: async () => {
      const held = heldFence;
      if (held) {
        heldFence = undefined;
        held.entered.release();
        await held.release.promise;
      }
      const tools = (await settings.load()).fleet.tools;
      return { tools, assertCurrent() {} };
    },
  };
  let worker = new WorkerMcp(workerOptions);
  const manual = options.manual
    ? await worker.issue({
        principalId: "manual-worker",
        workId: "VUH-FIXTURE",
        server: "linear",
        tools: [{ name: "save_issue", arguments: { id: "VUH-FIXTURE" }, forbiddenArguments: [] }],
        ttlSeconds: 900,
      })
    : undefined;
  let occupant = "fixture-native-session-1";
  let nativeProofs = 0;
  const identity = (pane = "w1:p1"): LocalFleetIdentity => ({
    fleet: "default",
    pane,
    // A synthetic admitted session: WorkerMcp-level only, never native admission proof.
    ...(options.native
      ? {
          admittedProjectProof: async () => {
            nativeProofs++;
            return {
              fleet: "default",
              pane,
              nativeOccupantId: occupant,
              binding: { socketPath: "/tmp/clankie-receipt-fixture.sock", session: "default" },
              shell: { pid: 4242, startTime: "1792400000.000001" },
              processes: [{ pid: 4343, startTime: "1792400001.000001" }],
            };
          },
        }
      : {}),
    current: () => valid,
    validate: async () => {
      if (authenticationFailure) throw authenticationFailure;
      return valid;
    },
  });
  const service = await listen((request) =>
    manual
      ? worker.handle(request)
      : worker.handleLocalFleet(request, identity(request.headers.get("x-fixture-pane") ?? "w1:p1")),
  );
  let sequence = 0;
  const bridgeId = randomUUID();
  const headers = (session?: string, pane = "w1:p1") => ({
    ...(manual ? { authorization: `Bearer ${manual.token}` } : {}),
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-clankie-bridge-id": bridgeId,
    "x-fixture-pane": pane,
    ...(session ? { "mcp-session-id": session } : {}),
  });
  const body = (method: string, params: unknown) => ({ jsonrpc: "2.0", id: ++sequence, method, params });
  const post = (method: string, params: unknown, session?: string, pane?: string, signal?: AbortSignal) =>
    fetch(service.url, {
      method: "POST",
      headers: headers(session, pane),
      body: JSON.stringify(body(method, params)),
      // Vitest bounds the fixture lifetime. A second HTTP deadline would turn
      // receipt/authority tests into latency tests; cancellation tests supply their signal.
      ...(signal === undefined ? {} : { signal }),
    });
  const initialize = async (pane?: string) => {
    const response = await post(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "worker-receipt-fixture", version: "1" },
      },
      undefined,
      pane,
    );
    expect(response.status).toBe(200);
    await response.json();
    const session = response.headers.get("mcp-session-id")!;
    expect(session).toBeTruthy();
    const initialized = await fetch(service.url, {
      method: "POST",
      headers: headers(session, pane),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(initialized.status).toBe(202);
    return session;
  };
  const call = async (
    args: { name?: string; arguments?: unknown; receiptId?: string; [key: string]: unknown },
    session: string,
    pane?: string,
    receiptId?: string,
    abandonmentId?: string,
  ) => {
    const response = await post(
      "tools/call",
      {
        name: manual ? args.name : "clankie_call",
        arguments: manual ? args.arguments : args,
        ...(receiptId === undefined && abandonmentId === undefined
          ? {}
          : {
              _meta: {
                ...(receiptId === undefined ? {} : { clankieReceiptId: receiptId }),
                ...(abandonmentId === undefined ? {} : { clankieAbandonmentId: abandonmentId }),
              },
            }),
      },
      session,
      pane,
    );
    expect(response.status).toBe(200);
    const reply = await response.json();
    return { ...JSON.parse(reply.result.content[0].text), toolError: reply.result.isError };
  };
  cleanup.push(async () => {
    release.release();
    heldFence?.release.release();
    heldCommit?.release.release();
    await worker.close();
    await host.close();
    await service.close();
    for (const session of providerSessions.values()) await session.server.close();
    await provider.close();
    await apiProvider?.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    call,
    post,
    initialize,
    status: () => worker.bridgeStatus("default", "w1:p1"),
    effects,
    admitted,
    release,
    observed,
    credentials,
    account,
    settings,
    localTracker,
    apiProvider,
    hostResults,
    holdCommit() {
      const held = { entered: gate(), release: gate(), settled: gate() };
      heldCommit = held;
      return held;
    },
    async revokeManual() {
      if (!manual) throw new Error("Missing manual fixture grant");
      return worker.revoke(manual.grant.grantId);
    },
    holdFence() {
      const held = { entered: gate(), release: gate() };
      heldFence = held;
      return held;
    },
    failAuthentication(error: Error) {
      authenticationFailure = error;
    },
    async restartWorker() {
      await worker.close();
      worker = new WorkerMcp(workerOptions);
    },
    revoke() {
      valid = false;
    },
    loseNextReply() {
      holdNextSettlement = true;
    },
    deliverLateSettlement() {
      const deliver = heldSettlement;
      heldSettlement = undefined;
      if (!deliver) throw new Error("No held settlement");
      deliver();
    },
    route(repo: string | undefined) {
      routedRepo = repo;
    },
    /** Fails the next route lookup after this many more succeed. */
    failRouteLookupAfter(lookups: number) {
      failRouteLookup = routeLookups + lookups + 1;
    },
    beforeLock(hook: () => void) {
      beforeLock = hook;
    },
    nativeProofs: () => nativeProofs,
    relaunchNative(id: string) {
      occupant = id;
    },
  };
}

const invocation = { name: "linear_save_issue", arguments: { id: "VUH-FIXTURE", state: "Done" } };

/** Read the committed root, never unreferenced shard preparations. Also supports legacy fixtures. */
async function receiptRows(path: string): Promise<Record<string, unknown>[]> {
  const root = JSON.parse(await readFile(path, "utf8"));
  if (Array.isArray(root)) return root;
  expect(root.format).toBe("clankie-receipts-v1");
  const rows = await Promise.all(
    Object.values(root.shards).map(
      async (file) =>
        JSON.parse(await readFile(join(`${path}.d`, String(file)), "utf8")) as Record<string, unknown>[],
    ),
  );
  return rows.flat();
}

it("migrates a large legacy connected-call ledger, changes one bucket, and preserves recovery across restart", async () => {
  const f = await fixture();
  f.release.release();
  let session = await f.initialize();
  const originalId = randomUUID();
  expect(await f.call(invocation, session, undefined, originalId)).toMatchObject({ outcome: "ok" });
  const journal = join(f.root, "grants", "receipts", "connected-calls.json");
  const [original] = await receiptRows(journal);
  const retained = Array.from({ length: 900 }, (_, index) => ({
    ...original,
    id: randomUUID(),
    createdAt: Date.now() + index,
    result: { outcome: "ok", isError: false, content: "retained provider response ".repeat(400) },
  }));
  const unknownId = randomUUID();
  const legacy = [...retained, { ...original, id: unknownId, state: "uncertain", result: undefined }];
  await writeFile(journal, JSON.stringify(legacy));
  await rm(`${journal}.d`, { recursive: true, force: true });
  const legacyBytes = (await stat(journal)).size;
  expect(legacyBytes).toBeGreaterThan(8_000_000);
  expect(await f.call(invocation, session, undefined, randomUUID())).toMatchObject({ outcome: "ok" });
  const before = JSON.parse(await readFile(journal, "utf8"));
  expect((await stat(journal)).size).toBeLessThan(30_000);
  const settledId = randomUUID();
  expect(await f.call(invocation, session, undefined, settledId)).toMatchObject({ outcome: "ok" });
  const after = JSON.parse(await readFile(journal, "utf8"));
  const changed = Object.values(after.shards).filter((file) => !Object.values(before.shards).includes(file));
  expect(changed).toHaveLength(1);
  const changedBytes =
    (await stat(journal)).size + (await stat(join(`${journal}.d`, String(changed[0])))).size;
  expect(changedBytes).toBeLessThan(legacyBytes / 20);
  expect(await readdir(`${journal}.d`)).toHaveLength(Object.keys(after.shards).length);
  const identity = await stat(journal, { bigint: true });
  const unchanged = spawnSync(
    process.execPath,
    [
      "--import",
      fileURLToPath(new URL("../../../scripts/dependency-types.mjs", import.meta.url)),
      fileURLToPath(new URL("./fixtures/connected-receipt-crash.mjs", import.meta.url)),
      journal,
      "unchanged",
    ],
    { encoding: "utf8" },
  );
  expect(unchanged.status, unchanged.stderr).toBe(0);
  const unchangedIdentity = await stat(journal, { bigint: true });
  expect(unchangedIdentity.ino).toBe(identity.ino);
  expect(unchangedIdentity.mtimeNs).toBe(identity.mtimeNs);
  const committed = await receiptRows(journal);
  expect(committed).toHaveLength(903);
  for (const row of retained) expect(committed.find((record) => record.id === row.id)).toEqual(row);
  const effects = f.effects.length;
  await f.restartWorker();
  session = await f.initialize();
  expect(await f.call({ receiptId: unknownId }, session)).toMatchObject({
    outcome: "uncertain",
    receiptId: unknownId,
  });
  expect(await f.call(invocation, session, undefined, unknownId)).toMatchObject({ outcome: "uncertain" });
  expect(await f.call(invocation, session, undefined, settledId)).toMatchObject({ outcome: "ok" });
  expect(f.effects).toHaveLength(effects);
  expect(await readFile(journal, "utf8")).toBe(JSON.stringify(after) + "\n");
});

it("recovers only committed connected admissions after a real process crash, never orphan preparations", async () => {
  const f = await fixture();
  f.release.release();
  let session = await f.initialize();
  expect(await f.call(invocation, session, undefined, randomUUID())).toMatchObject({ outcome: "ok" });
  const journal = join(f.root, "grants", "receipts", "connected-calls.json");
  const rootBefore = await readFile(journal, "utf8");
  const uncommitted = randomUUID();
  const run = (mode: string, id: string) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        fileURLToPath(new URL("../../../scripts/dependency-types.mjs", import.meta.url)),
        fileURLToPath(new URL("./fixtures/connected-receipt-crash.mjs", import.meta.url)),
        journal,
        mode,
        id,
      ],
      { encoding: "utf8" },
    );
  const failed = run("before", uncommitted);
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain("fixture manifest commit failure");
  expect(await readFile(journal, "utf8")).toBe(rootBefore);
  expect((await receiptRows(journal)).some((row) => row.id === uncommitted)).toBe(false);
  const admitted = randomUUID();
  const crashed = run("after", admitted);
  expect(crashed.signal).toBe("SIGKILL");
  await f.restartWorker();
  session = await f.initialize();
  expect(await f.call(invocation, session, undefined, admitted)).toMatchObject({
    outcome: "uncertain",
    receiptId: admitted,
  });
  expect(f.effects).toHaveLength(1);
  expect((await receiptRows(journal)).some((row) => row.id === admitted && row.state === "uncertain")).toBe(
    true,
  );
  expect((await receiptRows(journal)).some((row) => row.id === uncommitted)).toBe(false);
});

it("refuses connected dispatch when a committed shard is corrupt or missing, including a warmed receipt cache", async () => {
  const f = await fixture();
  f.release.release();
  const session = await f.initialize();
  const id = randomUUID();
  expect(await f.call(invocation, session, undefined, id)).toMatchObject({ outcome: "ok" });
  const journal = join(f.root, "grants", "receipts", "connected-calls.json");
  const manifest = JSON.parse(await readFile(journal, "utf8"));
  const path = join(`${journal}.d`, String(Object.values(manifest.shards)[0]));
  const body = await readFile(path, "utf8");
  await writeFile(path, body.replace('"settled"', '"unknown"'));
  expect(await f.call(invocation, session, undefined, id)).toMatchObject({
    outcome: "refused",
    detail: expect.stringContaining("receipts are unreadable"),
  });
  await rm(path);
  expect(await f.call(invocation, session, undefined, randomUUID())).toMatchObject({
    outcome: "refused",
    detail: expect.stringContaining("receipts are unreadable"),
  });
  expect(f.effects).toHaveLength(1);
  await writeFile(path, body);
  expect(await f.call(invocation, session, undefined, id)).toMatchObject({ outcome: "ok" });
  expect(f.effects).toHaveLength(1);
});

it("a manual grant revoked after its read recheck refuses dispatch without a provider effect", async () => {
  const f = await fixture({ manual: true });
  const session = await f.initialize();
  // A live grant must really reach this provider, so zero effects cannot pass
  // merely because the fixture's manual account/tool setup is broken.
  f.release.release();
  expect(await f.call(invocation, session)).toMatchObject({ outcome: "ok", toolError: false });
  expect(f.effects).toHaveLength(1);
  const held = f.holdCommit();
  const controller = new AbortController();
  const pending = f
    .post(
      "tools/call",
      { name: invocation.name, arguments: invocation.arguments },
      session,
      undefined,
      controller.signal,
    )
    .catch((error) => error);
  try {
    await held.entered.promise;
    expect((await f.revokeManual()).revokedAt).toBeDefined();
    held.release.release();
    await held.settled.promise;
    expect(f.hostResults.at(-1)).toMatchObject({ outcome: "refused", possiblyDispatched: false });
    expect(f.effects).toHaveLength(1);
  } finally {
    held.release.release();
    // Revoke closes the worker MCP transport. Inspect the host's actual
    // pre-dispatch refusal above, then release this fixture's waiting HTTP read.
    controller.abort();
    await pending;
  }
});

// These supplemental checks exercise the real locked tracker backend only.
// Its read callbacks are not native admission, account or project proof.
async function readBackendFixture(options: Omit<LocalTrackerOptions, "directory"> = {}) {
  const root = await mkdtemp(join(tmpdir(), "clankie-receipt-read-backend-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "tracker");
  return { root, directory, tracker: createLocalTracker({ ...options, directory }) };
}

async function trackerDigest(directory: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(join(directory, "tracker.json")))
    .digest("hex");
}

async function prepareUserRead(tracker: ReturnType<typeof createLocalTracker>): Promise<TrackerReadSnapshot> {
  let prepared: TrackerReadSnapshot | undefined;
  await tracker.call(
    "get_user",
    { query: "me" },
    {
      beforeRead: async () => {},
      onReadPrepared: (snapshot) => {
        prepared = snapshot;
      },
    },
  );
  if (!prepared) throw new Error("Expected initialized default-clock backend READ proof");
  return prepared;
}

it("actual tracker initialization stays UNKNOWN and its next unchanged get_user emits exact READ proof", async () => {
  const f = await readBackendFixture();
  const prepared: TrackerReadSnapshot[] = [];
  let checks = 0;
  let fences = 0;
  const options = {
    beforeRead: async () => {
      checks++;
      return () => {
        fences++;
      };
    },
    onReadPrepared: (snapshot: TrackerReadSnapshot) => {
      expect(fences).toBe(1);
      prepared.push(snapshot);
    },
  };
  const first = await f.tracker.call("get_user", { query: "me" }, options);
  expect(prepared).toHaveLength(0);
  expect(checks).toBe(0);
  const originalDigest = await trackerDigest(f.directory);
  const directoryIdentity = await stat(f.directory, { bigint: true });
  expect(await f.tracker.call("get_user", { query: "me" }, options)).toEqual(first);
  expect(prepared).toEqual([
    {
      version: 1,
      classification: "READ",
      contract: "builtin-strict-no-effect/v1",
      operation: "get_user",
      target: {
        kind: "builtin",
        canonicalDirectory: await realpath(f.directory),
        storeId: await f.tracker.storeId(),
        directoryIdentity: {
          dev: directoryIdentity.dev.toString(),
          ino: directoryIdentity.ino.toString(),
          birthTimeNs: directoryIdentity.birthtimeNs.toString(),
        },
      },
    },
  ]);
  expect(checks).toBe(1);
  expect(await trackerDigest(f.directory)).toBe(originalDigest);
});

it("actual snapshot recovery preserves the journal and rejects another initialized store without replay", async () => {
  const original = await readBackendFixture();
  const other = await readBackendFixture();
  await original.tracker.call("get_user", { query: "me" });
  await other.tracker.call("get_user", { query: "me" });
  const snapshot = await prepareUserRead(original.tracker);
  const originalDigest = await trackerDigest(original.directory);
  const otherDigest = await trackerDigest(other.directory);
  let callbacks = 0;
  expect(
    await original.tracker.withReadSnapshot(snapshot, async (assertCurrent) => {
      assertCurrent();
      callbacks++;
      assertCurrent();
      return "revalidated without calling get_user";
    }),
  ).toBe("revalidated without calling get_user");
  expect(callbacks).toBe(1);
  await expect(
    other.tracker.withReadSnapshot(snapshot, async () => {
      callbacks++;
    }),
  ).rejects.toThrow();
  expect(callbacks).toBe(1);
  expect(await trackerDigest(original.directory)).toBe(originalDigest);
  expect(await trackerDigest(other.directory)).toBe(otherDigest);
});

it("a late scratch-only canonical target replacement fails its final READ fence with both journals untouched", async () => {
  const original = await readBackendFixture();
  const other = await readBackendFixture();
  await original.tracker.call("get_user", { query: "me" });
  await other.tracker.call("get_user", { query: "me" });
  const alias = join(original.root, "scratch-target");
  await symlink(original.directory, alias, "dir");
  const aliased = createLocalTracker({ directory: alias });
  const snapshot = await prepareUserRead(aliased);
  const originalDigest = await trackerDigest(original.directory);
  const otherDigest = await trackerDigest(other.directory);
  let committed = false;
  await expect(
    aliased.withReadSnapshot(snapshot, async (assertCurrent) => {
      assertCurrent();
      // Repoint only this test's scratch alias between stores created by ordinary APIs.
      // No live binding or tracker.json is edited, transplanted or deleted.
      await rename(alias, join(original.root, "retained-scratch-target"));
      await symlink(other.directory, alias, "dir");
      assertCurrent();
      committed = true;
    }),
  ).rejects.toThrow();
  expect(committed).toBe(false);
  expect(await trackerDigest(original.directory)).toBe(originalDigest);
  expect(await trackerDigest(other.directory)).toBe(otherDigest);
});

it("actual list_runs with a host runner and mutations never emit READ proof", async () => {
  let runnerCalls = 0;
  const f = await readBackendFixture({
    runner: () => {
      runnerCalls++;
      return { source: "supplemental host callback" };
    },
  });
  const prepared: TrackerReadSnapshot[] = [];
  let readChecks = 0;
  const options = {
    beforeRead: async () => {
      readChecks++;
    },
    onReadPrepared: (snapshot: TrackerReadSnapshot) => {
      prepared.push(snapshot);
    },
  };
  const issue = (await f.tracker.call(
    "save_issue",
    { team: "LOCAL", title: "Supplemental runner read" },
    options,
  )) as { id: string };
  expect(prepared).toHaveLength(0);
  expect(readChecks).toBe(0);
  await f.tracker.call("save_run", { issueId: issue.id });
  const before = runnerCalls;
  const originalDigest = await trackerDigest(f.directory);
  await f.tracker.call("list_runs", {}, options);
  expect(runnerCalls).toBeGreaterThan(before);
  expect(prepared).toHaveLength(0);
  expect(readChecks).toBe(0);
  expect(await trackerDigest(f.directory)).toBe(originalDigest);
});

it("a configured clock stays UNKNOWN even for an initialized get_user", async () => {
  let clockCalls = 0;
  const f = await readBackendFixture({
    clock: () => {
      clockCalls++;
      return new Date("2026-01-01T00:00:00Z");
    },
  });
  await f.tracker.call("get_user", { query: "me" });
  const prepared: TrackerReadSnapshot[] = [];
  const originalDigest = await trackerDigest(f.directory);
  await f.tracker.call(
    "get_user",
    { query: "me" },
    {
      beforeRead: async () => {},
      onReadPrepared: (snapshot) => {
        prepared.push(snapshot);
      },
    },
  );
  expect(clockCalls).toBeGreaterThan(1);
  expect(prepared).toHaveLength(0);
  expect(await trackerDigest(f.directory)).toBe(originalDigest);
});

it("an ordinary cycle rollover stays UNKNOWN and retains its effects on a custom-clock backend", async () => {
  let clock = new Date("2026-01-01T00:00:00Z");
  const f = await readBackendFixture({ clock: () => clock });
  const project = (await f.tracker.call("save_project", {
    name: "Supplemental cycle",
    addTeams: ["LOCAL"],
    cycleDays: 1,
  })) as { id: string };
  await f.tracker.call("save_issue", {
    team: "LOCAL",
    project: project.id,
    title: "Roll this unfinished item",
    cycle: "current",
  });
  const originalDigest = await trackerDigest(f.directory);
  clock = new Date("2026-01-02T00:00:00Z");
  const prepared: TrackerReadSnapshot[] = [];
  await f.tracker.call(
    "get_user",
    { query: "me" },
    {
      beforeRead: async () => {},
      onReadPrepared: (snapshot) => {
        prepared.push(snapshot);
      },
    },
  );
  expect(prepared).toHaveLength(0);
  expect(await trackerDigest(f.directory)).not.toBe(originalDigest);
  // Custom clocks are independently UNKNOWN; this does not isolate rollover as the refusal cause.
  expect(await f.tracker.call("list_cycles", { project: project.id })).toMatchObject({
    cycles: expect.arrayContaining([expect.objectContaining({ number: 2 })]),
  });
});

it("receipt recovery keeps missing originals uncertain, reports unproven ones truthfully and rejects caller READ assertions", async () => {
  const f = await fixture({ local: true });
  const session = await f.initialize();
  const missing = randomUUID();
  const decision = randomUUID();
  expect(await f.call({ receiptId: missing, action: "inspect" }, session)).toMatchObject({
    outcome: "uncertain",
    classification: "UNKNOWN",
    receiptId: missing,
    toolError: false,
  });
  expect(
    await f.call(
      { receiptId: missing, action: "abandon-read", reason: "Stop waiting" },
      session,
      undefined,
      undefined,
      decision,
    ),
  ).toMatchObject({
    outcome: "refused",
    reason: "original_read_unproven",
    classification: "UNKNOWN",
    receiptId: missing,
    abandonmentId: decision,
    toolError: true,
  });
  const receiptId = randomUUID();
  const original = await f.call(
    { name: "linear_get_user", arguments: { query: "me" } },
    session,
    undefined,
    receiptId,
  );
  expect(original).toMatchObject({ outcome: "ok", receiptId });
  // Initialization is never READ proof; inspection still reports what was retained.
  expect(await f.call({ receiptId, action: "inspect" }, session)).toMatchObject({
    outcome: "inspected",
    classification: "UNKNOWN",
    recovery: { abandonable: false },
    execution: { response: "confirmed-success" },
    abandonment: { state: "not-observed" },
    toolError: false,
  });
  for (const assertion of [
    { readOnly: true },
    { classification: "READ" },
    { nativeOccupantId: "claimed" },
    { name: "linear_get_user", arguments: { query: "me" } },
  ]) {
    expect(await f.call({ receiptId, action: "inspect", ...assertion }, session)).toMatchObject({
      outcome: "refused",
      toolError: true,
    });
  }
  expect(
    await f.call(
      { receiptId, action: "abandon-read", reason: "Caller cannot prove READ" },
      session,
      undefined,
      undefined,
      decision,
    ),
  ).toMatchObject({
    outcome: "refused",
    reason: "original_read_unproven",
    classification: "UNKNOWN",
    receiptId,
    abandonmentId: decision,
  });
  expect(await f.call({ receiptId }, session)).toEqual(original);
  const other = await f.initialize("w1:p2");
  expect(await f.call({ receiptId, action: "inspect" }, other, "w1:p2")).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  await f.settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "off" } }));
  expect(await f.call({ receiptId, action: "inspect" }, session)).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
});

async function readFixture() {
  const f = await fixture({ local: true, native: true });
  const session = await f.initialize();
  // Initialize first: an initializing call is never READ.
  const issue = (await f.localTracker!.call("save_issue", { team: "LOCAL", title: "READ receipt" })) as {
    identifier: string;
  };
  const read = async (receiptId: string, id = issue.identifier) =>
    f.call({ name: "linear_get_issue", arguments: { id } }, session, undefined, receiptId);
  const inspect = (receiptId: string, abandonmentId?: string) =>
    f.call({ receiptId, action: "inspect", ...(abandonmentId ? { abandonmentId } : {}) }, session);
  const abandon = (receiptId: string, decision: string, reason = "Stop waiting") =>
    f.call({ receiptId, action: "abandon-read", reason }, session, undefined, undefined, decision);
  return { f, session, issue, read, inspect, abandon };
}

it("a READ-classified receipt inspects, abandons once and refuses a conflicting decision", async () => {
  const { read, inspect, abandon, f } = await readFixture();
  const receiptId = randomUUID();
  const original = await read(receiptId);
  expect(original).toMatchObject({ outcome: "ok", receiptId, toolError: false });
  expect(await inspect(receiptId)).toMatchObject({
    outcome: "inspected",
    classification: "READ",
    recovery: { abandonable: true },
    original: { readSnapshot: { contract: "builtin-strict-no-effect/v1", operation: "get_issue" } },
    execution: { dispatchAdmission: "recorded", response: "confirmed-success" },
    abandonment: { state: "not-observed" },
    toolError: false,
  });
  const decision = randomUUID();
  const first = await abandon(receiptId, decision);
  expect(first).toMatchObject({
    outcome: "abandoned-read",
    abandonmentId: decision,
    abandonment: { state: "recorded", decision: { id: decision, reason: "Stop waiting" } },
    toolError: false,
  });
  // The same decision again answers its original audit.
  expect(await abandon(receiptId, decision)).toEqual(first);
  const other = randomUUID();
  expect(await abandon(receiptId, other, "A different decision")).toMatchObject({
    outcome: "refused",
    reason: "abandonment_conflict",
    abandonmentId: other,
    recordedAbandonmentId: decision,
    toolError: true,
  });
  expect(await inspect(receiptId, other)).toMatchObject({
    outcome: "inspected",
    abandonment: { state: "recorded", decision: { id: decision }, requested: { id: other, recorded: false } },
  });
  // Recovery never touches the original result or replays the call.
  expect(await f.call({ receiptId }, (await f.initialize()) as string)).toEqual(original);
});

it("a mistyped key on a READ-classified call settles as a definite error", async () => {
  const { read, inspect } = await readFixture();
  const receiptId = randomUUID();
  expect(await read(receiptId, "LOCAL-404")).toMatchObject({
    outcome: "ok",
    isError: true,
    receiptId,
    toolError: true,
    content: expect.stringContaining("Issue not found"),
  });
  expect(await inspect(receiptId)).toMatchObject({
    outcome: "inspected",
    classification: "READ",
    execution: { response: "confirmed-error" },
  });
});

it("a lost READ reply stays uncertain, can be abandoned, and its late result keeps the audit", async () => {
  const { read, inspect, abandon, f } = await readFixture();
  const receiptId = randomUUID();
  f.loseNextReply();
  expect(await read(receiptId)).toMatchObject({ outcome: "uncertain", receiptId, toolError: false });
  expect(await inspect(receiptId)).toMatchObject({
    outcome: "inspected",
    classification: "READ",
    execution: { dispatchAdmission: "recorded", response: "UNKNOWN" },
  });
  const decision = randomUUID();
  expect(await abandon(receiptId, decision)).toMatchObject({
    outcome: "abandoned-read",
    execution: { response: "UNKNOWN" },
    abandonment: { state: "recorded" },
  });
  f.deliverLateSettlement();
  expect(await inspect(receiptId, decision)).toMatchObject({
    outcome: "inspected",
    execution: { response: "confirmed-success" },
    abandonment: { state: "recorded", decision: { id: decision } },
  });
});

it("another native session on the same pane cannot inspect or abandon a READ receipt", async () => {
  const { read, inspect, abandon, f } = await readFixture();
  const receiptId = randomUUID();
  await read(receiptId);
  f.relaunchNative("fixture-native-session-2");
  expect(await inspect(receiptId)).toMatchObject({
    outcome: "refused",
    reason: "receipt_recovery_unavailable",
    toolError: true,
  });
  expect(await abandon(receiptId, randomUUID())).toMatchObject({
    outcome: "refused",
    reason: "receipt_recovery_unavailable",
  });
  f.relaunchNative("fixture-native-session-1");
  expect(await inspect(receiptId)).toMatchObject({
    outcome: "inspected",
    abandonment: { state: "not-observed" },
  });
});

it("a route or grant change during recovery refuses without recording an abandonment", async () => {
  const { read, inspect, abandon, f } = await readFixture();
  const receiptId = randomUUID();
  await read(receiptId);
  let held = f.holdFence();
  const routed = abandon(receiptId, randomUUID());
  await held.entered.promise;
  f.route("/fixture/repository");
  held.release.release();
  expect(await routed).toMatchObject({
    outcome: "refused",
    reason: "receipt_recovery_unavailable",
    detail: "The worker's tracker route changed",
  });
  f.route(undefined);
  expect(await inspect(receiptId)).toMatchObject({
    outcome: "inspected",
    abandonment: { state: "not-observed" },
  });
  held = f.holdFence();
  const revoked = abandon(receiptId, randomUUID());
  await held.entered.promise;
  f.revoke();
  held.release.release();
  expect(await revoked).toMatchObject({ outcome: "refused", detail: "Fleet admission unavailable" });
  const retained = await receiptRows(join(f.root, "grants", "receipts", "connected-calls.json"));
  expect(retained.find((record) => record.id === receiptId)?.abandonment).toBeUndefined();
});

it("a route change after the pre-lock READ fence is caught at commit, for reads and for recovery", async () => {
  const { read, inspect, abandon, f } = await readFixture();
  const raced = randomUUID();
  f.beforeLock(() => f.route("/fixture/repository"));
  expect(await read(raced)).toMatchObject({
    outcome: "refused",
    possiblyDispatched: false,
    detail: "The worker's tracker route changed",
  });
  f.route(undefined);
  const receiptId = randomUUID();
  await read(receiptId);
  f.beforeLock(() => f.route("/fixture/repository"));
  expect(await abandon(receiptId, randomUUID())).toMatchObject({
    outcome: "refused",
    reason: "receipt_recovery_unavailable",
    detail: "The worker's tracker route changed",
  });
  f.route(undefined);
  expect(await inspect(receiptId)).toMatchObject({
    outcome: "inspected",
    classification: "READ",
    abandonment: { state: "not-observed" },
  });
});

it("an eligible read that can't retain a READ proof skips the native census and stays an ordinary read", async () => {
  const { read, inspect, f } = await readFixture();
  const proofs = f.nativeProofs();
  // Selectors over 1 KiB can't be retained, so no proof is gathered for them. No issue key is
  // that long, so the backend's not-found answer comes back as an ordinary definite refusal.
  expect(await read(randomUUID(), `LOCAL-404-${"x".repeat(1_100)}`)).toMatchObject({
    outcome: "refused",
    possiblyDispatched: false,
    detail: expect.stringContaining("Issue not found"),
  });
  expect(f.nativeProofs()).toBe(proofs);
  // A failed pre-lock READ fence falls back to the ordinary read instead of refusing it.
  f.failRouteLookupAfter(1);
  const fallback = randomUUID();
  expect(await read(fallback)).toMatchObject({ outcome: "ok", isError: false, receiptId: fallback });
  expect(await inspect(fallback)).toMatchObject({
    outcome: "inspected",
    classification: "UNKNOWN",
    execution: { response: "confirmed-success" },
  });
  expect(f.nativeProofs()).toBe(proofs);
  // A read that can retain its proof still gathers it.
  await read(randomUUID());
  expect(f.nativeProofs()).toBeGreaterThan(proofs);
});

it("a settled READ keeps its classification after retention trims its recovery proof", async () => {
  const { read, inspect, abandon, f } = await readFixture();
  const receiptId = randomUUID();
  await read(receiptId);
  // A thousand newer settled bodies push this one out at the next journal write.
  const journal = join(f.root, "grants", "receipts", "connected-calls.json");
  const records = await receiptRows(journal);
  const [original] = records.filter((record) => record.id === receiptId);
  await writeFile(
    journal,
    JSON.stringify([
      ...records,
      ...Array.from({ length: 1_000 }, (_, index) => ({
        ...original,
        id: randomUUID(),
        createdAt: Date.now() + index + 1,
        readSnapshot: undefined,
        nativeSubject: undefined,
      })),
    ]),
  );
  await read(randomUUID());
  const trimmed = await inspect(receiptId);
  expect(trimmed).toMatchObject({
    outcome: "inspected",
    classification: "READ",
    proofRetention: "trimmed",
    recovery: { abandonable: false },
    execution: { response: "settled-body-unavailable" },
  });
  expect(trimmed.original.readSnapshot).toBeUndefined();
  expect(await abandon(receiptId, randomUUID())).toMatchObject({
    outcome: "refused",
    reason: "original_read_unproven",
    classification: "READ",
  });
});

it("API-owned reads and writes retain scoped worker receipts without repeating provider calls", async () => {
  const f = await fixture({ api: true });
  const session = await f.initialize();
  const readId = randomUUID();
  const readArgs = { name: "linear_get_issue", arguments: { id: ISSUE_ID } };
  // Hold a real HTTP provider response past both former fixture-only budgets
  // (500 ms worker / 3 s receiver). Receipt scoping does not promise that latency.
  const held = f.apiProvider!.blockNextGraphql();
  const pending = f.call(readArgs, session, undefined, readId);
  try {
    await held.started;
    await new Promise<void>((resolve) => setTimeout(resolve, 3_100));
  } finally {
    held.release();
  }
  const read = await pending;
  await f.observed.promise;
  expect(read, JSON.stringify({ reason: read.reason, detail: read.detail })).toMatchObject({
    outcome: "ok",
    receiptId: readId,
    isError: false,
    toolError: false,
  });
  const reads = f.apiProvider!.seen.length;
  expect(await f.call({ receiptId: readId }, session)).toEqual(read);
  expect(await f.call(readArgs, session, undefined, readId)).toEqual(read);
  expect(f.apiProvider!.seen).toHaveLength(reads);
  const writeId = randomUUID();
  const writeArgs = {
    name: "linear_save_comment",
    arguments: { issueId: ISSUE_ID, body: "One API receipt" },
  };
  const write = await f.call(writeArgs, session, undefined, writeId);
  expect(write).toMatchObject({ outcome: "ok", receiptId: writeId, isError: false, toolError: false });
  expect(await f.call(writeArgs, session, undefined, writeId)).toEqual(write);
  expect(await f.call({ receiptId: writeId }, session)).toEqual(write);
  const writes = () =>
    f.apiProvider!.seen.filter((entry) => entry.query?.startsWith("mutation TrackerWrite"));
  expect(writes()).toHaveLength(1);
  expect(f.apiProvider!.rows.comments!.filter((row) => row.body === "One API receipt")).toHaveLength(1);
  await f.settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "off" } }));
  expect(await f.call({ receiptId: readId }, session)).toMatchObject({ outcome: "refused", toolError: true });
  expect(await f.call(writeArgs, session, undefined, randomUUID())).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  await f.settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "connected" } }));
  await f.credentials.update(LINEAR_API_PROVIDER_ID, async (current) => {
    if (current.type !== "oauth" || !current.account) throw new Error("Expected connected API account");
    return { ...current, account: { ...current.account, connectionId: randomUUID() } };
  });
  expect(await f.call({ receiptId: readId }, session)).toMatchObject({ outcome: "refused", toolError: true });
  expect(await f.call({ receiptId: writeId }, session)).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  expect(writes()).toHaveLength(1);
  expect(f.apiProvider!.validationErrors).toEqual([]);
});

it("a late API-owned read settles the same receipt with the model cap and no mutation admission", async () => {
  const f = await fixture({ api: true, requestTimeoutMs: SHORT_REQUEST_TIMEOUT_MS });
  const session = await f.initialize();
  f.apiProvider!.issue.description = "x".repeat(60_000);
  const held = f.apiProvider!.blockNextGraphql();
  const receiptId = randomUUID();
  try {
    const pending = f.call(
      { name: "linear_get_issue", arguments: { id: ISSUE_ID } },
      session,
      undefined,
      receiptId,
    );
    await held.started;
    const refused = await pending;
    expect(refused).toMatchObject({ outcome: "refused", toolError: true });
    // Both layers share the caller's deadline. Require the exact timeout
    // contract of whichever timer settles first, never an unrelated refusal.
    if (refused.reason === "worker_request_failed")
      expect(refused.detail).toBe(
        "Worker tool call timed out or was cancelled: TimeoutError: The operation was aborted due to timeout",
      );
    else {
      expect(refused.reason).toBe("server_unavailable");
      expect(refused.detail).toMatch(/^MCP linear\/get_issue timed out after ([1-9]\d{0,2})ms$/u);
      expect(Number(refused.detail.match(/after (\d+)ms$/u)?.[1])).toBeLessThanOrEqual(500);
    }
    held.release();
    await f.observed.promise;
    const count = f.apiProvider!.seen.length;
    const settled = await f.call({ receiptId }, session);
    expect(settled).toMatchObject({ outcome: "ok", receiptId, isError: false, toolError: false });
    expect(settled.content).toHaveLength(50_000);
    expect(await f.call({ receiptId }, session)).toEqual(settled);
    expect(f.apiProvider!.seen).toHaveLength(count);
    expect(f.apiProvider!.seen.some((entry) => entry.query?.startsWith("mutation"))).toBe(false);
  } finally {
    held.release();
    // The original API response owns its journal settlement after caller timeout.
    // Drain it before fixture cleanup removes the receipt directory.
    await f.observed.promise;
  }
});

it("an admitted API mutation keeps an uncertain receipt until its original response settles", async () => {
  const f = await fixture({ api: true, requestTimeoutMs: SHORT_REQUEST_TIMEOUT_MS });
  const session = await f.initialize();
  const held = f.apiProvider!.blockNextMutationResponse();
  const receiptId = randomUUID();
  const args = {
    name: "linear_save_comment",
    arguments: { issueId: ISSUE_ID, body: "One delayed API effect" },
  };
  try {
    const pending = f.call(args, session, undefined, receiptId);
    await held.started;
    expect(f.apiProvider!.rows.comments!.filter((row) => row.body === args.arguments.body)).toHaveLength(1);
    expect(await pending).toMatchObject({ outcome: "uncertain", receiptId, toolError: false });
    expect(await f.call({ receiptId }, session)).toMatchObject({
      outcome: "uncertain",
      receiptId,
      toolError: false,
    });
    expect(await f.call(args, session, undefined, receiptId)).toMatchObject({
      outcome: "uncertain",
      receiptId,
      toolError: false,
    });
    held.release();
    await f.observed.promise;
    const settled = await f.call({ receiptId }, session);
    expect(settled).toMatchObject({ outcome: "ok", receiptId, isError: false, toolError: false });
    await f.restartWorker();
    expect(await f.call({ receiptId }, await f.initialize())).toEqual(settled);
    expect(
      f.apiProvider!.seen.filter((entry) => entry.query?.startsWith("mutation TrackerWrite")),
    ).toHaveLength(1);
    expect(f.apiProvider!.rows.comments!.filter((row) => row.body === args.arguments.body)).toHaveLength(1);
    expect(f.apiProvider!.validationErrors).toEqual([]);
  } finally {
    held.release();
  }
});

const removeScratch = {
  name: "linear_graphql",
  arguments: {
    query: "mutation Remove($id: String!) { documentDelete(id: $id) { success } }",
    variables: { id: DOCUMENT_ID },
  },
};
const confirmedRemoval = {
  ...removeScratch,
  arguments: { ...removeScratch.arguments, confirm: [DOCUMENT_ID] },
};

it("a fleet worker queries and deletes a scratch document through linear_graphql with one durable receipt", async () => {
  const f = await fixture({ api: true });
  const session = await f.initialize();
  const deletes = () => f.apiProvider!.seen.filter((entry) => entry.query?.includes("documentDelete"));
  expect(await f.call(removeScratch, session)).toMatchObject({
    outcome: "refused",
    reason: "confirmation_required",
    toolError: true,
  });
  const read = await f.call(
    {
      name: "linear_graphql",
      arguments: {
        query: "query Scratch($id: String!) { document(id: $id) { id title } }",
        variables: { id: DOCUMENT_ID },
      },
    },
    session,
  );
  expect(read).toMatchObject({ outcome: "ok", isError: false, toolError: false });
  expect(JSON.parse(read.content)).toMatchObject({ data: { document: { id: DOCUMENT_ID } } });
  await f.settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "off" } }));
  expect(await f.call(confirmedRemoval, session)).toMatchObject({ outcome: "refused", toolError: true });
  await f.settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "connected" } }));
  expect(deletes()).toHaveLength(0);
  const receiptId = randomUUID();
  const removed = await f.call(confirmedRemoval, session, undefined, receiptId);
  expect(removed).toMatchObject({ outcome: "ok", receiptId, isError: false, toolError: false });
  expect(await f.call(confirmedRemoval, session, undefined, receiptId)).toEqual(removed);
  expect(await f.call({ receiptId }, session)).toEqual(removed);
  expect(deletes()).toHaveLength(1);
  expect(f.apiProvider!.rows.documents).toEqual([]);
  expect(f.apiProvider!.validationErrors).toEqual([]);
});

it("an uncertain linear_graphql mutation reconciles by receipt and is never resent", async () => {
  const f = await fixture({ api: true, requestTimeoutMs: SHORT_REQUEST_TIMEOUT_MS });
  const session = await f.initialize();
  const held = f.apiProvider!.blockNextMutationResponse();
  const receiptId = randomUUID();
  try {
    const pending = f.call(confirmedRemoval, session, undefined, receiptId);
    await held.started;
    expect(await pending).toMatchObject({ outcome: "uncertain", receiptId, toolError: false });
    expect(await f.call(confirmedRemoval, session, undefined, receiptId)).toMatchObject({
      outcome: "uncertain",
      receiptId,
    });
    held.release();
    await f.observed.promise;
    expect(await f.call({ receiptId }, session)).toMatchObject({
      outcome: "ok",
      receiptId,
      isError: false,
      toolError: false,
    });
    expect(f.apiProvider!.seen.filter((entry) => entry.query?.includes("documentDelete"))).toHaveLength(1);
    expect(f.apiProvider!.rows.documents).toEqual([]);
  } finally {
    held.release();
  }
});

it.each(["off", "account"] as const)(
  "refuses an API write when %s changes during its target lookup",
  async (change) => {
    const f = await fixture({ api: true });
    const session = await f.initialize();
    const held = f.apiProvider!.blockNextGraphql();
    try {
      const pending = f.call(
        { name: "linear_save_comment", arguments: { issueId: ISSUE_ID, body: "Refused API effect" } },
        session,
      );
      await held.started;
      if (change === "off") {
        await f.settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "off" } }));
      } else {
        await f.credentials.update(LINEAR_API_PROVIDER_ID, async (current) => {
          if (current.type !== "oauth" || !current.account) throw new Error("Expected connected API account");
          return { ...current, account: { ...current.account, connectionId: randomUUID() } };
        });
      }
      held.release();
      expect(await pending).toMatchObject({ outcome: "refused", toolError: true });
      expect(f.apiProvider!.seen.some((entry) => entry.query?.startsWith("mutation"))).toBe(false);
      expect(f.apiProvider!.rows.comments!.some((row) => row.body === "Refused API effect")).toBe(false);
    } finally {
      held.release();
    }
  },
);

it("local tracker reads and writes retain scoped receipts while the fleet kill switch blocks new effects", async () => {
  const f = await fixture({ local: true });
  const session = await f.initialize();
  const readId = randomUUID();
  const read = await f.call(
    { name: "linear_get_user", arguments: { query: "me" } },
    session,
    undefined,
    readId,
  );
  expect(read).toMatchObject({ outcome: "ok", receiptId: readId, isError: false, toolError: false });
  expect(JSON.stringify(JSON.parse(read.content)).toLowerCase()).toContain("local");
  expect(await f.call({ receiptId: readId }, session)).toEqual(read);
  const writeId = randomUUID();
  const write = { name: "linear_save_issue", arguments: { team: "LOCAL", title: "One local effect" } };
  const saved = await f.call(write, session, undefined, writeId);
  expect(saved).toMatchObject({ outcome: "ok", receiptId: writeId, isError: false, toolError: false });
  expect(await f.call(write, session, undefined, writeId)).toEqual(saved);
  expect(await f.call({ receiptId: writeId }, session)).toEqual(saved);
  expect(await f.localTracker!.call("list_issues", {})).toMatchObject({
    issues: [expect.objectContaining({ title: "One local effect" })],
  });
  await f.settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "off" } }));
  expect(
    await f.call(
      { ...write, arguments: { team: "LOCAL", title: "Blocked local effect" } },
      session,
      undefined,
      randomUUID(),
    ),
  ).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  expect(await f.localTracker!.call("list_issues", {})).toMatchObject({
    issues: [expect.objectContaining({ title: "One local effect" })],
  });
});

it("a timed-out admitted Linear write has a durable receipt and reconciles without redispatch", async () => {
  const f = await fixture({ requestTimeoutMs: SHORT_REQUEST_TIMEOUT_MS });
  const session = await f.initialize();
  const catalogResponse = await f.post("tools/list", {}, session);
  const catalog = ListToolsResultSchema.parse((await catalogResponse.json()).result);
  expect(catalog.tools.map((tool) => tool.name)).toEqual(["clankie_tools", "clankie_call"]);
  expect(catalog.tools[1]?.inputSchema).toMatchObject({ type: "object", anyOf: expect.any(Array) });
  const started = Date.now();
  const pending = f.call(invocation, session);
  await f.admitted.promise;
  expect(f.effects).toHaveLength(1);
  const uncertain = await pending;
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(uncertain).toMatchObject({
    outcome: "uncertain",
    receiptId: expect.any(String),
    detail: "may have applied; reconcile, don’t retry",
    toolError: false,
    reason: expect.stringMatching(/timed out|timeout/iu),
  });
  expect(f.status()).toMatchObject({ status: "stalled" });
  expect(await f.call({ receiptId: uncertain.receiptId }, session)).toMatchObject({
    outcome: "uncertain",
    receiptId: uncertain.receiptId,
    detail: uncertain.detail,
    reason: expect.stringMatching(/timed out|timeout/iu),
    toolError: false,
  });
  f.release.release();
  await f.observed.promise;
  expect(f.status()).toMatchObject({ status: "ready" });
  const settled = await f.call({ receiptId: uncertain.receiptId }, session);
  expect(settled).toMatchObject({
    outcome: "ok",
    receiptId: uncertain.receiptId,
    isError: false,
    toolError: false,
  });
  expect(JSON.parse(settled.content)).toMatchObject({ id: "VUH-FIXTURE", status: "Done" });
  expect(settled.content.length).toBeLessThan(1_000);
  expect(JSON.parse(settled.content).description).toContain("chars saved");
  expect(f.effects).toHaveLength(1);
  await f.restartWorker();
  const restored = await f.initialize();
  expect(await f.call({ receiptId: uncertain.receiptId }, restored)).toEqual(settled);
  expect(await f.call({ receiptId: randomUUID() }, restored)).toMatchObject({
    outcome: "uncertain",
    toolError: false,
  });
  const otherPane = await f.initialize("w1:p2");
  expect(await f.call({ receiptId: uncertain.receiptId }, otherPane, "w1:p2")).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  await f.settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "off" } }));
  expect(await f.call({ receiptId: uncertain.receiptId }, restored)).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  await f.settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "connected" } }));
  await f.credentials.set("linear", {
    type: "api",
    key: "fixture-provider-secret",
    account: { ...f.account, connectionId: randomUUID() },
  });
  expect(await f.call({ receiptId: uncertain.receiptId }, restored)).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  expect(f.effects).toHaveLength(1);
});

it("late read receipt reconciliation preserves the model-facing 50k content cap", async () => {
  const f = await fixture({ requestTimeoutMs: SHORT_REQUEST_TIMEOUT_MS });
  const session = await f.initialize();
  const receiptId = randomUUID();
  const pending = f.call({ name: "linear_read_large", arguments: {} }, session, undefined, receiptId);
  await f.admitted.promise;
  expect(await pending).toMatchObject({ outcome: "uncertain", receiptId });
  f.release.release();
  await f.observed.promise;
  const settled = await f.call({ receiptId }, session);
  expect(settled).toMatchObject({ outcome: "ok", receiptId, isError: false });
  expect(settled.content).toBe("x".repeat(50_000));
  expect(f.effects).toHaveLength(0);
});

it("an admitted write settles durably after its receiving HTTP request is cancelled", async () => {
  const f = await fixture();
  const session = await f.initialize();
  const receiver = new AbortController();
  const receiptId = randomUUID();
  const pending = f
    .post(
      "tools/call",
      { name: "clankie_call", arguments: invocation, _meta: { clankieReceiptId: receiptId } },
      session,
      undefined,
      receiver.signal,
    )
    .catch((error: unknown) => error);
  await f.admitted.promise;
  receiver.abort();
  expect(await pending).toBeInstanceOf(Error);
  expect(await f.call({ receiptId }, session)).toMatchObject({ outcome: "uncertain", receiptId });
  f.release.release();
  await f.observed.promise;
  expect(await f.call({ receiptId }, session)).toMatchObject({ outcome: "ok", receiptId, isError: false });
  expect(f.effects).toHaveLength(1);
});

it("a supplied receipt ID admits one concurrent write and rejects changed inputs or authority", async () => {
  const f = await fixture({ requestTimeoutMs: SHORT_REQUEST_TIMEOUT_MS });
  const session = await f.initialize();
  const receiptId = randomUUID();
  const pending = f.call(invocation, session, undefined, receiptId);
  const repeated = f.call(
    { arguments: { state: "Done", id: "VUH-FIXTURE" }, name: "linear_save_issue" },
    session,
    undefined,
    receiptId,
  );
  await f.admitted.promise;
  const uncertain = await pending;
  expect(uncertain).toMatchObject({ outcome: "uncertain", receiptId });
  expect(await repeated).toMatchObject({
    outcome: "uncertain",
    receiptId,
    detail: uncertain.detail,
    toolError: false,
  });
  expect(await f.call({ receiptId }, session)).toMatchObject({
    outcome: "uncertain",
    receiptId,
    reason: expect.stringMatching(/timed out|timeout/iu),
    toolError: false,
  });
  expect(
    await f.call(
      { name: "linear_save_issue", arguments: { id: "VUH-FIXTURE", state: "In Progress" } },
      session,
      undefined,
      receiptId,
    ),
  ).toMatchObject({ outcome: "refused", toolError: true });
  expect(await f.call(invocation, session, undefined, "not-a-uuid")).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  expect(await f.call({ ...invocation, receiptId }, session)).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  const otherPane = await f.initialize("w1:p2");
  expect(await f.call(invocation, otherPane, "w1:p2", receiptId)).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  expect(f.effects).toHaveLength(1);
  f.release.release();
  await f.observed.promise;
  const settled = await f.call({ receiptId }, session);
  expect(settled).toMatchObject({ outcome: "ok", receiptId, isError: false });
  expect(await f.call(invocation, session, undefined, receiptId)).toEqual(settled);
  await f.restartWorker();
  const restored = await f.initialize();
  expect(await f.call(invocation, restored, undefined, receiptId)).toEqual(settled);
  await f.credentials.set("linear", {
    type: "api",
    key: "fixture-provider-secret",
    account: { ...f.account, connectionId: randomUUID() },
  });
  expect(await f.call(invocation, restored, undefined, receiptId)).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  expect(f.effects).toHaveLength(1);
});

it("an expired pre-dispatch fence cannot mutate the provider after its delayed read releases", async () => {
  const f = await fixture({ requestTimeoutMs: SHORT_REQUEST_TIMEOUT_MS });
  const session = await f.initialize();
  const held = f.holdFence();
  const receiptId = randomUUID();
  const pending = f.call(invocation, session, undefined, receiptId);
  await held.entered.promise;
  expect(await f.call({ receiptId }, session)).toMatchObject({
    outcome: "uncertain",
    receiptId,
    toolError: false,
  });
  expect(await pending).toMatchObject({ outcome: "refused", toolError: true });
  held.release.release();
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  expect(f.effects).toHaveLength(0);
  expect(await f.call({ receiptId }, session)).toMatchObject({
    outcome: "uncertain",
    receiptId,
    toolError: false,
  });
});

it("a missing receipt during original setup stays uncertain until the original applies once", async () => {
  const f = await fixture();
  const session = await f.initialize();
  const held = f.holdFence();
  const receiptId = randomUUID();
  const pending = f.call(invocation, session, undefined, receiptId);
  await held.entered.promise;
  expect(await f.call({ receiptId }, session)).toMatchObject({
    outcome: "uncertain",
    receiptId,
    toolError: false,
  });
  expect(f.effects).toHaveLength(0);
  f.release.release();
  held.release.release();
  const settled = await pending;
  expect(settled).toMatchObject({ outcome: "ok", receiptId, toolError: false });
  expect(await f.call({ receiptId }, session)).toEqual(settled);
  expect(f.effects).toHaveLength(1);
});

it("unauthenticated worker failures do not expose internal authentication details", async () => {
  const f = await fixture();
  f.failAuthentication(new Error("private authority backend failure fixture-secret"));
  const response = await f.post("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: "worker_grant_unavailable",
    reason: "Worker access unavailable",
  });
  expect(f.effects).toHaveLength(0);
});
