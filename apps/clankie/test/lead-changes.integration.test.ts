import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer as httpServer } from "node:http";
import { createServer as socketServer } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CONNECTOR_GRANTS, LeadChangesResultSchema, type LeadChangesResult } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { afterEach, expect, it, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { InboundSeatReceipts } from "../src/captain/inbound-seat-receipts.ts";
import { LeadStore } from "../src/captain/lead.ts";
import { FleetRoomJournal } from "../src/captain/fleet-room.ts";
import { ConnectorDetection } from "../src/app/connector-detection.ts";
import { LeadChanges } from "../src/lead-changes.ts";
import { createWorkItemsService } from "../src/work-items.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import {
  createCaptainConversationDispatch,
  createDeviceConversationDispatch,
} from "../../relay/src/conversation-upstream.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";
import { createConnectorMcpHandler, createLoopbackConnectorOperator } from "../../relay/src/connector-mcp.ts";
import { ClankieGuide } from "../../relay/src/connector-guide.ts";

const checkpointReadFence = vi.hoisted(() => ({ callback: undefined as undefined | (() => void) }));
const cleanupFence = vi.hoisted(() => ({ callback: undefined as undefined | (() => Promise<void>) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const value = await actual.readFile(...args);
      if (
        String(args[0]).includes("/changes/") &&
        String(args[0]).endsWith(".json") &&
        checkpointReadFence.callback
      ) {
        const callback = checkpointReadFence.callback;
        checkpointReadFence.callback = undefined;
        callback();
      }
      return value;
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await actual.rm(...args);
      if (
        String(args[0]).includes("/changes/") &&
        String(args[0]).endsWith(".tmp") &&
        cleanupFence.callback
      ) {
        const callback = cleanupFence.callback;
        cleanupFence.callback = undefined;
        await callback();
      }
    },
  };
});

const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  cleanupFence.callback = undefined;
  checkpointReadFence.callback = undefined;
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lead-changes-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  await exec("git", ["init", "--quiet", repo]);
  await exec("git", ["-C", repo, "remote", "add", "origin", "https://github.com/fixture/project.git"]);
  const state = join(root, "captain");
  await mkdir(state);
  const leadPath = join(state, "lead.json"),
    heldPath = join(state, "lead-held.json");
  const lead = new LeadStore(leadPath, heldPath);
  lead.set("apps");
  lead.hold({
    conversationId: "global-default",
    origin: "watch",
    text: "Historical watch; not proof an issue is open",
  });
  new FleetRoomJournal(join(state, "fleet-room")).postAppNote("App A", "A board note");
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({ ...current, herdr: { ...current.herdr, runtime: "disabled" } }));
  let questionId = "";
  const addReport = (store: ConversationStore, deviceId: string, text: string) => {
    const id = randomUUID();
    const receipts = new InboundSeatReceipts(join(root, "receipt-" + id + ".json"), store);
    const accepted = receipts.accept(
      "worker-" + deviceId,
      { id, binding: "a".repeat(64) },
      text,
      text,
      "global-default",
      async (_id, _message, _publish, context) => {
        context?.deliveryReceipt?.("unavailable");
      },
      { source: "adoption", conversationId: "global-default" },
      { kind: "conversation", owner: { conversationId: "global-default" } },
      false,
      "worker-" + deviceId,
      { deviceId },
      "update",
    );
    expect(accepted.received).toBe(true);
    return id;
  };
  const seed = new ConversationStore(join(state, "conversations"), async () => {});
  const reportA = addReport(seed, "app-a", "Report A");
  const reportB = addReport(seed, "app-b", "PRIVATE OTHER APP REPORT");
  await seed.close();

  let desktopSession = "native-finished-session",
    desktopIdle = false;
  const nativeMethods: string[] = [];
  const native = socketServer((socket) => {
    let buffer = "";
    socket.on("data", (bytes) => {
      buffer += String(bytes);
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"),
          line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const rpc = JSON.parse(line) as { id: number; method: string };
        nativeMethods.push(rpc.method);
        const result =
          rpc.method === "hello"
            ? { generation: 1, methods: ["terminal.list"] }
            : {
                terminals: [
                  {
                    address: "fixture/t1",
                    state: desktopIdle ? "live" : "finished",
                    created_ms: 1,
                    title: "Finished worker",
                    ...(desktopIdle
                      ? {
                          reported: true,
                          pid: 16777213,
                          argv: ["codex"],
                          foreground: { pid: 16777213, name: "codex", argv: ["codex"] },
                          status: { app: "codex", state: "idle" },
                          labels: {},
                        }
                      : {
                          labels: {
                            "clankie.seat": "worker",
                            "clankie.session": desktopSession,
                            "clankie.agent": "codex",
                          },
                        }),
                  },
                ],
              };
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }) + "\n");
      }
    });
  });
  const nativePath = join(root, "hc.sock");
  native.listen(nativePath);
  await once(native, "listening");
  cleanups.push(() => new Promise<void>((done) => native.close(() => done())));
  vi.stubEnv("HC_SOCKET", nativePath);

  let prStatus: "open" | "merged" = "open",
    githubUnavailable = false;
  const githubRequests: string[] = [];
  let githubGate: { entered: () => void; wait: Promise<void> } | undefined;
  const holdGithub = () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((done) => {
      enter = done;
    });
    const wait = new Promise<void>((done) => {
      release = done;
    });
    githubGate = { entered: enter, wait };
    cleanups.push(release);
    return { entered, release };
  };
  const github = httpServer((request, response) => {
    void (async () => {
      const gate = githubGate;
      githubGate = undefined;
      if (gate) {
        gate.entered();
        await gate.wait;
      }
      githubRequests.push(request.url!);
      expect(request.method).toBe("GET");
      response.setHeader("content-type", "application/json");
      if (githubUnavailable) return response.writeHead(503).end("{}");
      const openOnly = new URL(request.url!, "http://fixture").searchParams.get("state") === "open";
      response.end(
        JSON.stringify(
          openOnly && prStatus === "merged"
            ? []
            : [
                {
                  number: 7,
                  html_url: "https://github.com/fixture/project/pull/7",
                  title: "A canonical PR",
                  state: prStatus === "merged" ? "closed" : "open",
                  merged_at: prStatus === "merged" ? new Date().toISOString() : null,
                  updated_at: new Date().toISOString(),
                },
              ],
        ),
      );
    })();
  });
  github.listen(0, "127.0.0.1");
  await once(github, "listening");
  cleanups.push(() => {
    github.closeAllConnections();
    return new Promise<void>((done) => github.close(() => done()));
  });
  const githubUrl = "http://127.0.0.1:" + (github.address() as { port: number }).port;
  let githubConnectionHook: undefined | (() => Promise<void>);
  const work = createWorkItemsService({
    stateDirectory: join(root, "work"),
    workspace: () => repo,
    githubToken: async () => {
      await githubConnectionHook?.();
      return "fixture-github-token";
    },
    githubApiBase: githubUrl,
  });
  const detection = new ConnectorDetection();
  const eventLogPath = join(root, "events.jsonl"),
    sessionKey = randomBytes(32),
    now = Date.now();
  const events = ["app-a", "app-b"].flatMap((deviceId) =>
    [
      {
        type: "device.pairing.redeemed",
        data: {
          offerId: deviceId,
          name: deviceId,
          platform: "unknown",
          offeredGrants: CONNECTOR_GRANTS,
          mintedBy: "local-operator",
          scope: "connector",
          pendingExpiresAt: new Date(now + 60_000).toISOString(),
        },
      },
      {
        type: "device.activated",
        data: { grants: CONNECTOR_GRANTS, sessionExpiresAt: new Date(now + 3600_000).toISOString() },
      },
    ].map((event) => ({
      id: randomUUID(),
      type: event.type,
      occurredAt: new Date(now).toISOString(),
      missionId: "device:" + deviceId,
      correlationId: "changes-proof",
      profileHash: "fixture",
      data: { schemaVersion: 1, deviceId, ...event.data },
    })),
  );
  await writeFile(eventLogPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const signer = new DeviceSessionSigner(sessionKey);
  const token = (deviceId: string) =>
    signer.issue(
      mintDeviceSessionClaims({ deviceId, nowEpochSeconds: Math.floor(now / 1000), ttlSeconds: 3600 }),
    );
  const makeCaptain = () =>
    createCaptain({ herdrAvailable: () => false } as CaptainDeps, {
      repoRoot: root,
      stateDir: state,
      workingDirectory: repo,
      settings,
      seatAdapters: [],
      discordEnvironment: {},
      fleetRoundIntervalMs: 3600_000,
    });
  let captain = makeCaptain();
  let leadStatusHook: undefined | (() => Promise<void>);
  const originalServe = captain.serveOperatorConversation.bind(captain);
  captain.serveOperatorConversation = async (...args) => {
    const result = await originalServe(...args);
    if (args[0].op === "lead" && args[0].command.action === "status") await leadStatusHook?.();
    return result;
  };
  const asked = await captain.requestOwnerAsk(
    "global-default",
    {
      purpose: "decision",
      kind: "choice",
      prompt: "PRIVATE OWNER QUESTION BODY",
      waitingOn: "Owner answer",
      recommendation: "Yes",
      options: [{ label: "Yes" }, { label: "No" }],
      allowFreeform: false,
    },
    "fixture-owner-question",
  );
  expect(asked.question).toBeDefined();
  questionId = asked.question!.requestId;

  const makeService = () =>
    createClankieApp({
      eventLogPath,
      deviceSessionKey: sessionKey,
      captain,
      settings,
      workItems: work,
      connectorDetection: detection,
      leadChanges: new LeadChanges(join(root, "changes")),
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === "Bearer fixture-owner-token-for-lead-changes"
          ? { operatorId: "owner" }
          : undefined,
      authenticateCaptain: async (request) =>
        request.headers.get("authorization") === "Bearer fixture-relay-token-for-lead-changes"
          ? { captainId: "relay", steerSourceLane: "api" }
          : undefined,
    });
  let service = await makeService();
  cleanups.push(async () => {
    await service.close();
    await captain.close();
  });
  const primary = serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => service.app.fetch(request) });
  if (!primary.listening) await once(primary, "listening");
  cleanups.push(() => {
    if ("closeAllConnections" in primary) primary.closeAllConnections();
    return new Promise<void>((done) => primary.close(() => done()));
  });
  const primaryUrl = "http://127.0.0.1:" + (primary.address() as { port: number }).port;
  const authorizer = new ControlPlaneDeviceAuthorizer({ baseUrl: primaryUrl });
  const operator = createOperatorConversationRelayHandler({
    authorizeDevice: authorizer,
    dispatch: createCaptainConversationDispatch({
      baseUrl: primaryUrl,
      bearerToken: "fixture-relay-token-for-lead-changes",
    }),
    deviceDispatch: createDeviceConversationDispatch({ baseUrl: primaryUrl }),
  });
  let relayUrl = "";
  const connector = createConnectorMcpHandler({
    authorizeDevice: authorizer,
    operator: createLoopbackConnectorOperator("http://placeholder.invalid", (input, init) =>
      fetch(new URL(new URL(String(input)).pathname, relayUrl), init),
    ),
    localAuthorizationServer: primaryUrl,
    version: "fixture",
    guide: new ClankieGuide(resolve(import.meta.dirname, "../../..")),
  });
  const relay = httpServer((request, response) => {
    void (async () => {
      if (await connector(request, response)) return;
      if (await operator(request, response)) return;
      response.writeHead(404).end();
    })();
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  cleanups.push(() => {
    relay.closeAllConnections();
    return new Promise<void>((done) => relay.close(() => done()));
  });
  relayUrl = "http://127.0.0.1:" + (relay.address() as { port: number }).port;
  const post = (body: unknown, who = "app-a") =>
    fetch((who === "owner" ? primaryUrl : relayUrl) + "/operator/v1/dispatch", {
      method: "POST",
      headers: {
        authorization: "Bearer " + (who === "owner" ? "fixture-owner-token-for-lead-changes" : token(who)),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const read = async (since?: string, limit = 100, who = "app-a") => {
    const response = await post(
      { op: "lead_changes", schemaVersion: 1, ...(since ? { since } : {}), limit },
      who,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json();
    return LeadChangesResultSchema.parse(body.result);
  };
  const ready = (page: LeadChangesResult) => {
    if (page.outcome !== "ready") throw Error("Unexpected reset");
    return page;
  };
  return {
    root,
    state,
    repo,
    primaryUrl,
    relayUrl,
    token,
    post,
    read,
    ready,
    reportA,
    reportB,
    questionId,
    detection,
    githubRequests,
    nativeMethods,
    hookGithubConnection: (hook: () => Promise<void>) => {
      githubConnectionHook = hook;
    },
    hookLeadStatus: (hook: () => Promise<void>) => {
      leadStatusHook = hook;
    },
    holdGithub,
    mergePr: () => {
      prStatus = "merged";
    },
    failGithub: (value: boolean) => {
      githubUnavailable = value;
    },
    replaceDesktop: () => {
      desktopSession = randomUUID();
    },
    idleDesktop: () => {
      desktopIdle = true;
    },
    withdrawAsk: () => captain.withdrawOwnerAsk("global-default", questionId, "resolved_elsewhere"),
    async restart(edit?: (store: ConversationStore) => Promise<unknown>) {
      await service.close();
      await captain.close();
      const store = new ConversationStore(join(state, "conversations"), async () => {});
      if (edit) await edit(store);
      await store.close();
      captain = makeCaptain();
      service = await makeService();
    },
    addReport,
  };
}

it("reads real stores through signed relay, MCP and CLI without acknowledging or crossing app/owner boundaries", async () => {
  const f = await fixture();
  const client = new Client({ name: "connected-lead-proof", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(f.relayUrl + "/mcp"), {
      requestInit: { headers: { authorization: "Bearer " + f.token("app-a") } },
    }) as unknown as Transport,
  );
  cleanups.push(() => client.close());
  expect(
    (await client.listTools()).tools.find((tool) => tool.name === "read_changes")?.annotations?.readOnlyHint,
  ).toBe(true);
  const result = await client.callTool({ name: "read_changes", arguments: {} });
  expect(result.isError).not.toBe(true);
  const content = result.content as { type: string; text: string }[];
  const page = f.ready(LeadChangesResultSchema.parse(JSON.parse(content[0]!.text)));
  expect(page.entries.map((entry) => entry.item.kind)).toEqual(
    expect.arrayContaining(["worker_report", "inbox", "pane", "pull_request", "board_note"]),
  );
  expect(page.entries.find((entry) => entry.id === f.reportA)?.state).toBe("active");
  expect(JSON.stringify(page)).not.toContain("PRIVATE OTHER APP REPORT");
  expect(JSON.stringify(page)).not.toContain("PRIVATE OWNER QUESTION BODY");
  expect(page.entries.some((entry) => entry.id === f.questionId)).toBe(false);
  expect(page.entries.find((entry) => entry.item.kind === "pane")?.state).toBe("resolved");
  const other = f.ready(await f.read(undefined, 100, "app-b"));
  expect(other.entries.some((entry) => entry.id === f.reportA)).toBe(false);
  expect(other.entries.some((entry) => entry.id === f.reportB)).toBe(true);
  expect(f.githubRequests.length).toBeGreaterThan(0);
  const scopeTheft = await f.post({ op: "lead_changes", schemaVersion: 1, since: page.next }, "app-b");
  expect(scopeTheft.status).toBe(403);
  const spoof = await f.post({ op: "lead_changes", schemaVersion: 1, appDeviceId: "app-b" });
  expect(spoof.status).toBe(400);
  const tampered = await f.post({ op: "lead_changes", schemaVersion: 1, since: page.next + "x" });
  expect(tampered.status).toBe(403);
  const cli = await exec(
    process.execPath,
    [
      "--import",
      resolve("apps/tui/node_modules/tsx/dist/loader.mjs"),
      resolve("apps/tui/bin/clankie.ts"),
      "connector",
      "changes",
      "--json",
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: f.root,
        NODE_ENV: "test",
        CLANKIE_OPERATOR_TOKEN: "fixture-owner-token-for-lead-changes",
        CLANKIE_CONTROL_PLANE_URL: f.primaryUrl,
      },
      timeout: 30_000,
    },
  );
  const owned = f.ready(LeadChangesResultSchema.parse(JSON.parse(cli.stdout)));
  expect(owned.entries.some((entry) => entry.item.kind === "owner_ask" && entry.id === f.questionId)).toBe(
    true,
  );
  expect(JSON.stringify(owned)).not.toContain("PRIVATE OWNER QUESTION BODY");
  await expect(
    exec(
      process.execPath,
      [
        "--import",
        resolve("apps/tui/node_modules/tsx/dist/loader.mjs"),
        resolve("apps/tui/bin/clankie.ts"),
        "connector",
        "changes",
        "--since",
        page.next,
        "--json",
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: f.root,
          NODE_ENV: "test",
          CLANKIE_OPERATOR_TOKEN: "fixture-owner-token-for-lead-changes",
          CLANKIE_CONTROL_PLANE_URL: f.primaryUrl,
        },
        timeout: 30_000,
      },
    ),
  ).rejects.toMatchObject({
    code: 1,
    stdout:
      JSON.stringify({
        ok: false,
        status: "invalid_cursor",
        error:
          "The changes cursor is invalid for this caller or visibility scope. Start again without --since.",
      }) + "\n",
    stderr: "",
  });
  f.withdrawAsk();
  const askSettled = f.ready(await f.read(owned.next, 100, "owner"));
  expect(askSettled.entries.find((entry) => entry.id === f.questionId)).toMatchObject({
    state: "superseded",
    removed: true,
  });
  const retained = new ConversationStore(join(f.state, "conversations"), async () => {});
  expect(retained.inboundReports("global-default").map((report) => report.deliveryId)).toEqual(
    expect.arrayContaining([f.reportA, f.reportB]),
  );
  expect(retained.inboundAcceptance(f.reportA)?.reportDelivery?.offeredAt).toBeUndefined();
  await retained.close();
});

it("overlaps a frozen bootstrap with inserts and resolutions across a real service restart", async () => {
  const f = await fixture();
  let page = f.ready(await f.read(undefined, 1));
  expect(page.more).toBe(true);
  const first = page.next;
  let inserted = "";
  f.mergePr();
  f.replaceDesktop();
  await f.restart(async (store) => {
    inserted = f.addReport(store, "app-a", "Arrived during bootstrap");
    store.readInboundReports("global-default", { deliveryIds: [f.reportA] });
    expect(store.acknowledgeInboundReports("global-default", [f.reportA])).toBe(true);
  });
  const seen = [...page.entries];
  for (let attempts = 0; page.more; attempts++) {
    expect(attempts).toBeLessThan(30);
    page = f.ready(await f.read(page.next, 1));
    seen.push(...page.entries);
  }
  const delta = f.ready(await f.read(page.next));
  seen.push(...delta.entries);
  expect(seen.some((entry) => entry.id === inserted)).toBe(true);
  expect(seen.filter((entry) => entry.id === f.reportA).at(-1)?.state).toBe("resolved");
  expect(seen.filter((entry) => entry.item.kind === "pull_request").at(-1)?.item).toMatchObject({
    status: "merged",
  });
  expect(
    seen.some(
      (entry) => entry.item.kind === "pane" && entry.removed === true && entry.state === "superseded",
    ),
  ).toBe(true);
  const repeated = f.ready(await f.read(first));
  expect(repeated.entries.some((entry) => entry.id === f.reportA && entry.state === "active")).toBe(false);
  const quiet = f.ready(await f.read(delta.next));
  expect(quiet.entries).toEqual([]);
});

it("keeps unavailable sources unknown, recovers them, and refuses after lead or serving revocation", async () => {
  const f = await fixture();
  const initial = f.ready(await f.read());
  f.idleDesktop();
  const idle = f.ready(await f.read(initial.next));
  expect(
    idle.entries.find((entry) => entry.item.kind === "pane" && entry.item.status === "idle"),
  ).toMatchObject({ state: "active" });
  f.failGithub(true);
  const unavailable = f.ready(await f.read(idle.next));
  expect(unavailable.sources).toContainEqual(
    expect.objectContaining({ source: "pull_request", status: "unavailable" }),
  );
  expect(
    unavailable.entries
      .filter((entry) => entry.item.kind === "pull_request")
      .every((entry) => entry.state === "unknown" && !entry.removed),
  ).toBe(true);
  f.failGithub(false);
  const recovered = f.ready(await f.read(unavailable.next));
  expect(recovered.entries.find((entry) => entry.item.kind === "pull_request")?.state).toBe("active");
  f.detection.setServed("app-a", false);
  expect((await f.post({ op: "lead_changes", schemaVersion: 1, since: recovered.next })).status).toBe(403);
  f.detection.setServed("app-a", true);
  expect(
    (await f.post({ op: "lead", schemaVersion: 1, command: { action: "set", lead: "clankie" } }, "owner"))
      .status,
  ).toBe(200);
  expect((await f.post({ op: "lead_changes", schemaVersion: 1, since: recovered.next })).status).toBe(403);
});

it("requires an explicit fresh bootstrap when the real held-turn journal prunes an unseen range", async () => {
  const f = await fixture();
  const initial = f.ready(await f.read());
  await writeFile(
    join(f.state, "lead-held.json"),
    JSON.stringify({
      schemaVersion: 1,
      nextSeq: 1001,
      items: Array.from({ length: 500 }, (_, index) => ({
        seq: 501 + index,
        at: new Date().toISOString(),
        conversationId: "global-default",
        origin: "watch",
        text: "Retained turn " + index,
      })),
    }),
  );
  await f.restart();
  expect(await f.read(initial.next)).toEqual({ outcome: "reset_required", reason: "retained_history_gap" });
  const fresh = f.ready(await f.read(undefined, 1));
  expect(fresh.bootstrap).toBe(true);
  expect(fresh.more).toBe(true);
});

it("refuses an in-flight source read after serving or device revocation", async () => {
  const f = await fixture();
  const initial = f.ready(await f.read());
  f.mergePr();
  const gate = f.holdGithub();
  const reading = f.post({ op: "lead_changes", schemaVersion: 1, since: initial.next });
  await gate.entered;
  f.detection.setServed("app-a", false);
  gate.release();
  const denied = await reading;
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ error: "not_authorized" });
  f.detection.setServed("app-a", true);
  const recovered = f.ready(await f.read(initial.next));
  expect(recovered.entries.find((entry) => entry.item.kind === "pull_request")?.item).toMatchObject({
    status: "merged",
  });
  const revokeGate = f.holdGithub();
  const revokedReading = f.post({ op: "lead_changes", schemaVersion: 1, since: recovered.next });
  await revokeGate.entered;
  const revoke = await fetch(f.primaryUrl + "/v1/devices/app-a/revoke", {
    method: "POST",
    headers: { authorization: "Bearer fixture-owner-token-for-lead-changes" },
  });
  expect(revoke.status).toBe(200);
  revokeGate.release();
  expect((await revokedReading).status).toBe(403);
  expect((await f.post({ op: "lead_changes", schemaVersion: 1, since: recovered.next })).status).toBe(401);
});

it("discovery off must hide desktop panes in a fresh scope", async () => {
  const f = await fixture();
  const enabled = f.ready(await f.read());
  expect(enabled.entries.some((e) => e.item.kind === "pane")).toBe(true);
  f.detection.setMultiplexer("herdr", false);
  const before = [...f.nativeMethods];
  expect((await f.post({ op: "lead_changes", schemaVersion: 1, since: enabled.next })).status).toBe(403);
  const page = f.ready(await f.read());
  expect(page.entries.filter((e) => e.item.kind === "pane")).toEqual([]);
  expect(page.sources).toContainEqual({
    source: "pane",
    status: "unavailable",
    reason: "discovery_disabled",
  });
  expect(f.nativeMethods).toEqual(before);
});

it("corrupt held journal is unavailable, not a complete empty inbox", async () => {
  const f = await fixture();
  const initial = f.ready(await f.read());
  expect(initial.entries.some((e) => e.item.kind === "inbox")).toBe(true);
  const journal = join(f.state, "lead-held.json");
  const saved = await readFile(journal, "utf8");
  await writeFile(journal, "{broken");
  await f.restart();
  const page = f.ready(await f.read(initial.next));
  expect(page.sources.find((s) => s.source === "inbox")?.status).toBe("unavailable");
  expect(
    page.entries.filter((e) => e.item.kind === "inbox").every((e) => e.state === "unknown" && !e.removed),
  ).toBe(true);
  const retained = f.ready(await f.read());
  expect(retained.entries.filter((e) => e.item.kind === "inbox")).toEqual(
    initial.entries
      .filter((e) => e.item.kind === "inbox")
      .map((e) => ({ ...e, sequence: expect.any(Number) })),
  );
  await writeFile(journal, saved);
  await f.restart();
  const recovered = f.ready(await f.read(page.next));
  expect(recovered.sources).toContainEqual({ source: "inbox", status: "ready" });
  expect(recovered.entries.some((e) => e.item.kind === "inbox" && e.removed)).toBe(false);
});

it("serving revocation during real checkpoint cleanup must refuse publication", async () => {
  const f = await fixture();
  const initial = f.ready(await f.read());
  f.mergePr();
  cleanupFence.callback = async () => {
    f.detection.setServed("app-a", false);
  };
  try {
    const response = await f.post({ op: "lead_changes", schemaVersion: 1, since: initial.next });
    expect(cleanupFence.callback).toBeUndefined();
    expect(response.status).toBe(403);
  } finally {
    cleanupFence.callback = undefined;
  }
});

it("rechecks authority before publishing an early retained-history reset", async () => {
  const f = await fixture();
  const initial = f.ready(await f.read(undefined, 1));
  expect(initial.more).toBe(true);
  const files = await readdir(join(f.root, "changes"));
  expect(files).toHaveLength(1);
  const path = join(f.root, "changes", files[0]!);
  const checkpoint = JSON.parse(await readFile(path, "utf8"));
  // A valid retained checkpoint whose older observations have been pruned.
  checkpoint.floor = checkpoint.head;
  checkpoint.history = [];
  await writeFile(path, JSON.stringify(checkpoint));
  expect(await f.read(initial.next)).toEqual({ outcome: "reset_required", reason: "retained_history_gap" });
  checkpointReadFence.callback = () => f.detection.setServed("app-a", false);
  const response = await f.post({ op: "lead_changes", schemaVersion: 1, since: initial.next });
  expect(checkpointReadFence.callback).toBeUndefined();
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "not_authorized" });
});

it("a repository visibility change during the last async authority read refuses publication", async () => {
  const f = await fixture();
  const initial = f.ready(await f.read());
  f.mergePr();
  let reads = 0;
  cleanupFence.callback = async () => {
    f.hookLeadStatus(async () => {
      if (++reads === 4)
        await exec("git", [
          "-C",
          f.repo,
          "remote",
          "set-url",
          "origin",
          "https://github.com/fixture/other.git",
        ]);
    });
  };
  const response = await f.post({ op: "lead_changes", schemaVersion: 1, since: initial.next });
  expect(reads).toBe(4);
  expect(response.status).toBe(403);
});

it("the synchronous publication fence detects an origin changed during scope preparation", async () => {
  const f = await fixture();
  const initial = f.ready(await f.read());
  f.mergePr();
  let reads = 0,
    changed = false;
  cleanupFence.callback = async () => {
    f.hookLeadStatus(async () => {
      if (++reads === 4)
        f.hookGithubConnection(async () => {
          if (changed) return;
          changed = true;
          await exec("git", [
            "-C",
            f.repo,
            "remote",
            "set-url",
            "origin",
            "https://github.com/fixture/other.git",
          ]);
        });
    });
  };
  const response = await f.post({ op: "lead_changes", schemaVersion: 1, since: initial.next });
  expect(reads).toBe(4);
  expect(changed).toBe(true);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "not_authorized" });
});
