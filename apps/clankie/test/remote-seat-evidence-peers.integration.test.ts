import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { decodeMcpResult } from "@clankie/protocol/mcp-result";
import { SettingsStore } from "@clankie/settings";
import { afterEach, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { deliveryFingerprint } from "../src/captain/delivery-fence.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import type { HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import { PeerSeatMessages } from "../src/captain/peer-seat-messages.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { EvidenceStore } from "../src/evidence-store.ts";
import { fleetLinkFetch } from "../src/fleet-link.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";

const exec = promisify(execFile);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const plugin = join(import.meta.dirname, "../../../integrations/claude-plugin/worker/bin");
const pane = "w15:p7";
const seat = (paneId: string, terminalId: string, agent = "claude"): HerdrAgentSnapshot => ({
  paneId,
  terminalId,
  agent,
  status: "idle",
  title: terminalId,
  session: { source: `herdr:${agent}`, kind: "id", value: `${terminalId}-session` },
});
// A PC worker, a PC peer nobody leads, the lead's reviewer on the Mac, and
// another lead's Mac seat. Leads are persisted per native occupant.
const sender = seat(`pc/${pane}`, "pc/term_sender");
const pcPeer = seat("pc/w15:p8", "pc/term_pcpeer", "codex");
const reviewer = seat("w1:p2", "term_reviewer");
const stranger = seat("w1:p3", "term_stranger");
const seats = [sender, pcPeer, reviewer, stranger];
const leads = new Map([
  [sender.terminalId, { conversationId: "lead-a" }],
  [reviewer.terminalId, { conversationId: "lead-a" }],
  [stranger.terminalId, { conversationId: "lead-b" }],
]);
const fleetOf = (agent: HerdrAgentSnapshot) => (agent.paneId.startsWith("pc/") ? "pc" : "default");
const binding = (agent: HerdrAgentSnapshot) =>
  deliveryFingerprint(JSON.stringify([agent.paneId, agent.terminalId, agent.agent, agent.session]));
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/**
 * The service as a PC pane reaches it: the real app, WorkerMcp and evidence
 * store over HTTP, behind the link listener's route filter. Only the Windows
 * relay's pane proof is a fixture; like FleetLinks.fetch, the listener admits a
 * request only when it names this fleet's pane.
 */
async function service() {
  const root = await mkdtemp(join(tmpdir(), "clankie-remote-seat-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    fleet: { ...current.fleet, tools: "connected", peerMessages: "on" },
  }));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const host = createMcpHost({ credentials, settings, curated: [], logger: { info() {}, warn() {} } });
  const worker = new WorkerMcp({
    directory: join(root, "grants"),
    credentials,
    host,
    fleetTools: async () => (await settings.load()).fleet.tools,
    fleetPeerMessages: async () => (await settings.load()).fleet.peerMessages,
  });
  const store = EvidenceStore.local(join(root, "evidence"));
  const delivered: { seatId: string; text: string }[] = [];
  const peers = new PeerSeatMessages({
    path: join(root, "peer-messages.json"),
    enabled: async () => (await settings.load()).fleet.peerMessages === "on",
    sender: async (paneId) => seats.find((agent) => agent.paneId === paneId),
    recipient: async (id) => seats.find((agent) => agent.terminalId === id || agent.paneId === id),
    seats: async (fleet) => seats.filter((agent) => fleetOf(agent) === fleet),
    lead: (agent) => leads.get(agent.terminalId),
    // The captain prefilters its roster by the lead's conversation.
    leadSeats: async (lead) =>
      seats.filter((agent) => leads.get(agent.terminalId)?.conversationId === lead.conversationId),
    deliver: async (seatId, text, options) => {
      if (!options.fence || !(await options.fence(seats.find((agent) => agent.terminalId === seatId))))
        return { outcome: "undelivered", detail: "The native authority changed." };
      delivered.push({ seatId, text });
      return { outcome: "delivered", messageId: randomUUID(), state: "queued" };
    },
    record: () => undefined,
  });
  const proof = {
    fleet: "pc",
    pane,
    nativeOccupantId: occupantIdForHerdrSession(sender.session!),
    binding: { socketPath: "native-fixture" },
    shell: { pid: 1, startTime: "native-fixture" },
    processes: [{ pid: 2, startTime: "native-fixture" }],
  };
  const app = await createClankieApp({
    captain: createStubCaptain({
      listFleetPeerSeats: (authority) => peers.list(authority),
      sendFleetPeerMessage: (authority, input) => peers.send(authority, input),
      reconcileFleetPeerMessage: (authority, delivery, fingerprint) =>
        peers.reconcile(authority, delivery, fingerprint),
      fleetSeatEvidenceActor: async (authority) =>
        (await authority.validate())
          ? {
              kind: "seat",
              id: sender.terminalId,
              name: "Rowan",
              onBehalfOf: [{ kind: "conversation", id: "lead-a" }],
            }
          : undefined,
    }),
    workerMcp: worker,
    evidenceStore: store,
    fleetLinks: {
      authenticate: () => undefined,
      identity: () => ({
        fleet: "pc",
        pane,
        current: () => true,
        validate: async () => true,
        projectProof: async () => proof,
      }),
    },
  });
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: fleetLinkFetch((request: Request) =>
      request.headers.get("x-clankie-pane") === pane
        ? app.app.fetch(request)
        : Response.json({ error: "remote_pane_required" }, { status: 403 }),
    ),
  });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing service address");
  const url = `http://127.0.0.1:${String(address.port)}`;
  cleanup.push(async () => {
    app.close();
    await worker.close();
    await host.close();
    store.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  });
  // The Windows relay publishes a process-authenticated link, not a bearer.
  const socket = join(root, "herdr.sock");
  await mkdir(join(root, ".clankie", "links"), { recursive: true });
  await writeFile(
    join(root, ".clankie", "links", "pc.json"),
    JSON.stringify({ schemaVersion: 2, authentication: "local-process", fleet: "pc", socket, url }),
  );
  const env = { PATH: process.env.PATH, HOME: root, HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: pane };
  return { root, url, env, store, delivered };
}

/** The worker bridge the PC runs, over stdio. */
function bridge(env: NodeJS.ProcessEnv) {
  const entry = pathToFileURL(join(plugin, "seat-channel.mjs"));
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {runSeatChannel} from ${JSON.stringify(entry.href)};runSeatChannel({paneId:${JSON.stringify(pane)},parentArgv:"codex"});`,
    ],
    { env },
  );
  cleanup.push(async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    await exited;
  });
  const replies = new Map<number, { result?: unknown; error?: unknown }>();
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += String(chunk);
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (message.id !== undefined) replies.set(message.id, message);
    }
  });
  let id = 0;
  return async (method: string, params: unknown) => {
    const current = ++id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`);
    await expect.poll(() => replies.has(current), { timeout: 20_000 }).toBe(true);
    const response = replies.get(current)!;
    expect(response.error).toBeUndefined();
    return response.result as { content: { text: string }[]; isError?: boolean; tools?: { name: string }[] };
  };
}

async function repository(root: string) {
  const repo = join(root, "work", "kh2");
  await mkdir(join(repo, "docs/testing/run"), { recursive: true });
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args]);
  await git("init", "-b", "main");
  await git(
    "-c",
    "user.name=Integration",
    "-c",
    "user.email=integration@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  );
  return repo;
}

// VUH-2923: on the PC there is no `clankie` CLI and no operator credential, so
// a worker's evidence never reached the store. The same push now goes through
// the pane's fleet link, from the plugin's own `clankie` and its bridge tool.
it("pushes a PC pane's evidence over its fleet link with the file's sha256 stored end to end", async () => {
  const { root, env, store } = await service();
  const repo = await repository(root);
  const folder = join(repo, "docs/testing/run");
  await writeFile(join(folder, "README.md"), "# PC run\n");
  const log = Buffer.from("frame ".repeat(5_000));
  const shot = Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    ...randomUUID()
      .split("")
      .map((c) => c.charCodeAt(0)),
  ]);
  await writeFile(join(folder, "run.log"), log);
  await writeFile(join(folder, "shot.png"), shot);

  // The plugin's own `clankie` on PATH, as Claude Code runs it from the plugin's bin/.
  const pushed = await exec(
    "sh",
    [join(plugin, "clankie"), "evidence", "push", "docs/testing/run", "--issue", "VUH-2923"],
    { cwd: repo, env },
  );
  const result = JSON.parse(pushed.stdout) as {
    ok: boolean;
    uploaded: number;
    added: { path: string; url: string }[];
  };
  expect(result, pushed.stderr).toMatchObject({ ok: true, uploaded: 2 });
  expect(result.added).toEqual([
    { path: "run.log", url: `clankie://evidence/sha256/${sha256(log)}` },
    { path: "shot.png", url: `clankie://evidence/sha256/${sha256(shot)}` },
  ]);
  const manifest = JSON.parse(await readFile(join(folder, "evidence.json"), "utf8")) as {
    objects: { path: string; sha256: string }[];
  };
  expect(manifest.objects.map((object) => [object.path, object.sha256])).toEqual([
    ["run.log", sha256(log)],
    ["shot.png", sha256(shot)],
  ]);
  // The raw bytes left git's tree for the local mirror.
  await expect(stat(join(folder, "run.log"))).rejects.toThrow();
  expect(sha256(await readFile(join(repo, ".local/evidence/docs/testing/run/run.log")))).toBe(sha256(log));

  // The store holds exactly the PC file's bytes, attributed to the seat and its lead.
  const records = await store.list({ issueKey: "VUH-2923" });
  expect(records.map((record) => record.sha256).sort()).toEqual([sha256(log), sha256(shot)].sort());
  for (const record of records) {
    expect(record.actor).toEqual({
      kind: "seat",
      id: "pc/term_sender",
      name: "Rowan",
      onBehalfOf: [{ kind: "conversation", id: "lead-a" }],
    });
    const blob = await store.blobs.open(record.sha256);
    expect(sha256(Buffer.from(await new Response(blob!.body).arrayBuffer()))).toBe(record.sha256);
  }

  // A Codex pane has no plugin bin/ on PATH; its bridge advertises the same push.
  const call = bridge(env);
  await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex", version: "1" },
  });
  const listed = await call("tools/list", {});
  expect(listed.tools?.map((tool) => tool.name)).toContain("evidence_push");
  const second = Buffer.from("second ".repeat(4_000));
  await mkdir(join(repo, "docs/testing/bridge"));
  await writeFile(join(repo, "docs/testing/bridge/capture.txt"), second);
  const tool = await call("tools/call", {
    name: "evidence_push",
    arguments: { path: join(repo, "docs/testing/bridge"), issue: "VUH-2923" },
  });
  expect(tool.isError, tool.content[0]?.text).toBeUndefined();
  expect(decodeMcpResult(tool)).toMatchObject({
    ok: true,
    added: [{ path: "capture.txt", url: `clankie://evidence/sha256/${sha256(second)}` }],
  });
  expect((await store.list({ issueKey: "VUH-2923" })).map((record) => record.sha256)).toContain(
    sha256(second),
  );
}, 60_000);

// VUH-2923: a PC worker could message only seats on the PC. One lead's seats
// now reach each other on any fleet machine; another lead's never do.
it("delivers a PC pane's peer message to its lead's Mac reviewer and never to another lead's seat", async () => {
  const { url, env, delivered } = await service();
  const call = bridge(env);
  await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex", version: "1" },
  });
  const listed = decodeMcpResult(await call("tools/call", { name: "list_fleet_seats", arguments: {} })) as {
    seats: { seatId: string }[];
  };
  expect(listed.seats.map((entry) => entry.seatId).sort()).toEqual(["pc/term_pcpeer", "term_reviewer"]);

  const sent = await call("tools/call", {
    name: "message_peer",
    arguments: { seat: "term_reviewer", text: "Candidate ready for review." },
  });
  expect(decodeMcpResult(sent)).toMatchObject({ outcome: "delivered", seatId: "term_reviewer" });
  expect(delivered).toEqual([
    { seatId: "term_reviewer", text: expect.stringContaining("Candidate ready for review.") },
  ]);

  // The bridge never offers another lead's seat, and the service refuses a
  // hand-built message to it even with its exact native binding.
  const refused = await call("tools/call", {
    name: "message_peer",
    arguments: { seat: "term_stranger", text: "Hello from the PC." },
  });
  expect(decodeMcpResult(refused)).toMatchObject({ outcome: "undelivered" });
  const forged = await fetch(`${url}/v1/fleet/seats/${encodeURIComponent(pane)}/peer-messages`, {
    method: "POST",
    headers: { "x-clankie-pane": pane, "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      seatId: stranger.terminalId,
      recipientBinding: binding(stranger),
      text: "Hello from the PC.",
      delivery: { id: randomUUID(), binding: binding(sender) },
    }),
  });
  expect(await forged.json()).toMatchObject({ outcome: "undelivered", deliveryStage: "rejected" });
  expect(delivered).toHaveLength(1);
}, 60_000);
