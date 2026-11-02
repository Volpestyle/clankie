import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, expect, it, vi } from "vitest";
import {
  FLEET_LEADS_PATH,
  FleetLeadsSnapshotSchema,
  TAKE_CONTROL_GRANTS,
  OPERATOR_CONVERSATION_DISPATCH_PATH,
} from "@clankie/protocol";
import { hostedOperatorAllows } from "@clankie/protocol/hosted-operator";
import { createClankieApp } from "../src/app.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { TurnMetrics, TurnSettledLog, turnSettledLogPath } from "../src/captain/turn-metrics.ts";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import { runHeadlessCaptainCommand } from "../../tui/bin/headless-captain.ts";
import { runFleetLeadsCommand } from "../../tui/src/command/fleet-leads.ts";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrSeatSpawnResult,
} from "../src/captain/herdr-watch.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { leadChatFixture } from "./fixtures/lead-chats.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

it("reads real host lead and device facts over HTTP, including the relay's throttled connector activity", async () => {
  const workers: HerdrAgentSnapshot[] = [];
  const f = await leadChatFixture(false, cleanup, {
    nativeSourceProof: true,
    extraAgents: () => workers,
    closePane: async (pane, guard) => {
      await guard?.();
      const index = workers.findIndex((agent) => agent.paneId === pane);
      if (index >= 0) workers.splice(index, 1);
    },
  });
  await f.settings.update((settings) => ({
    ...settings,
    projects: {
      ...settings.projects,
      projects: [
        {
          id: "proof",
          name: "Proof",
          workspaces: [{ id: "local", machineId: "local", platform: "posix", path: f.root }],
          worktreeRoots: [],
          roles: [],
          labelRoleMap: [],
          grants: [],
        },
      ],
    },
  }));
  // Replace only native allocation/delivery: real start admission writes its hire intent,
  // real journal binding and census retain attribution, and real HTTP reads project it.
  const native = HerdrWatchStore.prototype as unknown as { performSpawnSeat: HerdrWatchStore["spawnSeat"] };
  const briefs: string[] = [];
  vi.spyOn(native, "performSpawnSeat").mockImplementation(
    async function (this: HerdrWatchStore, request, _subject, brief, _resume, authority, adopt, flush) {
      if (!authority?.intentId) throw new Error("No persisted hire intent");
      briefs.push(brief ?? "");
      const index = workers.length;
      const agent: HerdrAgentSnapshot = {
        paneId: `w4:p${index + 3}`,
        terminalId: `term_worker_${index}`,
        agent: "codex",
        status: "idle",
        title: request.title,
        workingDirectory: f.root,
        session: { source: "herdr:codex", kind: "id", value: randomUUID() },
      };
      const occupantId = occupantIdForHerdrSession(agent.session!);
      const journal = (this as unknown as { hireOwners: HireOwners }).hireOwners;
      journal.bind(
        agent.paneId,
        authority.owner,
        agent.terminalId,
        authority.intentId,
        occupantId,
        undefined,
        "proof",
      );
      workers.push(agent);
      const result: Extract<HerdrSeatSpawnResult, { outcome: "spawned" }> = {
        outcome: "spawned",
        seat: {
          seatId: agent.terminalId,
          paneId: agent.paneId,
          occupantId,
          subject: `proof-${index}`,
          harness: "codex",
          status: "idle",
          title: request.title,
          workingDirectory: f.root,
        },
      };
      adopt?.(result, "proof");
      await flush?.();
      return result;
    },
  );
  let now = Date.now();
  const iso = (offset = 0) => new Date(now + offset).toISOString();
  const key = randomBytes(32);
  const signer = new DeviceSessionSigner(key);
  const events: unknown[] = [];
  for (const id of ["recent", "old", "unseen", "revoked", "expired", "ordinary"]) {
    const event = (type: string, data: object, at = iso(-60 * 60_000)) => ({
      id: randomUUID(),
      type,
      occurredAt: at,
      missionId: `device:${id}`,
      correlationId: "fleet-leads-proof",
      profileHash: "fixture",
      data: { schemaVersion: 1, deviceId: id, ...data },
    });
    events.push(
      event("device.pairing.redeemed", {
        offerId: id,
        name: id === "recent" ? "Claude" : id,
        platform: "unknown",
        offeredGrants: TAKE_CONTROL_GRANTS,
        mintedBy: "local-operator",
        pendingExpiresAt: iso(60_000),
        ...(id === "ordinary" ? {} : { scope: "connector" }),
        ...(id === "expired" ? { run: { runId: "expired-proof", purpose: "test", expiresAt: iso(-1) } } : {}),
      }),
    );
    events.push(
      event("device.activated", { grants: TAKE_CONTROL_GRANTS, sessionExpiresAt: iso(60 * 60_000) }),
    );
    if (id !== "unseen")
      events.push(event("device.seen", {}, iso(id === "old" ? -16 * 60_000 : -2 * 60_000)));
    if (id === "revoked") events.push(event("device.revoked", { revokedBy: "local-operator" }));
  }
  const eventLogPath = join(f.root, "leads-devices.jsonl");
  await writeFile(eventLogPath, events.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const service = await createClankieApp({
    captain: f.captain,
    deviceSessionKey: key,
    eventLogPath,
    clock: () => new Date(now),
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer relay"
        ? { captainId: "relay", steerSourceLane: "api" }
        : undefined,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  cleanup.push(async () => service.close());
  const server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  cleanup.push(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const read = async (bearer = "owner") =>
    fetch(`${baseUrl}${FLEET_LEADS_PATH}`, { headers: { authorization: `Bearer ${bearer}` } });
  const snapshot = async () => {
    const response = await read();
    expect(response.status).toBe(200);
    return FleetLeadsSnapshotSchema.parse(await response.json());
  };
  const initial = await snapshot();
  expect(initial.leads.map((lead) => [lead.id, lead.active])).toEqual([
    ["clankie", true],
    ["old", false],
    ["recent", true],
    ["unseen", false],
  ]);
  expect(initial.leads.find((lead) => lead.id === "recent")).toMatchObject({ name: "Claude", kind: "app" });
  expect(hostedOperatorAllows("GET", FLEET_LEADS_PATH)).toBe(true);
  expect(hostedOperatorAllows("POST", FLEET_LEADS_PATH)).toBe(false);
  const token = (id: string) =>
    signer.issue(
      mintDeviceSessionClaims({ deviceId: id, nowEpochSeconds: Math.floor(now / 1000), ttlSeconds: 3600 }),
    );
  expect((await read(token("recent"))).status).toBe(403);
  expect((await read("unknown")).status).toBe(403);
  expect((await read(token("ordinary"))).status).toBe(200);
  const cli = await runFleetLeadsCommand(["--json"], {
    host: baseUrl,
    env: { CLANKIE_OPERATOR_TOKEN: "owner" },
  });
  expect(cli.leads).toEqual(initial.leads);
  for (const args of [
    ["fleet", "leads"],
    ["fleet", "leads", "--json"],
  ]) {
    let output = "";
    const code = await runHeadlessCaptainCommand(args, {
      repoRoot: f.root,
      host: baseUrl,
      env: { CLANKIE_OPERATOR_TOKEN: "owner" },
      stdout: {
        write: (chunk) => {
          output += chunk;
        },
      },
    });
    expect(code).toBe(0);
    if (args.includes("--json"))
      expect(FleetLeadsSnapshotSchema.parse(JSON.parse(output)).leads).toEqual(initial.leads);
    else expect(output).toContain("recent\tClaude\tactive");
  }

  const dispatch = async (body: object, bearer = "relay") => {
    const response = await fetch(`${baseUrl}${OPERATOR_CONVERSATION_DISPATCH_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, ...body }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  };
  const expanded = async () => {
    const response = await fetch(`${baseUrl}${FLEET_LEADS_PATH}?includeChannels=true`, {
      headers: { authorization: "Bearer owner" },
    });
    expect(response.status).toBe(200);
    return FleetLeadsSnapshotSchema.parse(await response.json());
  };
  const beforeChannels = await (await read()).text();
  for (const channel of ["   ", "x".repeat(65), 42]) {
    const invalid = await fetch(`${baseUrl}${OPERATOR_CONVERSATION_DISPATCH_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer relay", "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, op: "start_agent", appDeviceId: "recent", channel }),
    });
    expect(invalid.status).toBe(400);
  }
  for (const channel of ["a", "b"]) {
    let started = await dispatch({
      op: "start_agent",
      appDeviceId: "recent",
      channel: ` ${channel} `,
      machine: "local",
      workingDirectory: f.root,
      harness: "codex",
      name: `Task ${channel}`,
      prompt: "Do the assigned job.",
    });
    if (started.status === "pending") {
      await expect
        .poll(async () => {
          started = await dispatch({ op: "start_agent", appDeviceId: "recent", startId: started.startId });
          return started.status;
        })
        .toBe("started");
    }
    expect(started.status).toBe("started");
  }
  expect(briefs).toHaveLength(2);
  expect(briefs.every((brief) => !brief.includes('"channel"') && !brief.includes("channel:"))).toBe(true);
  const journal = new HireOwners(join(f.root, "herdr-watches.json.owners.json"));
  const own = workers.map((agent) => ({
    seatId: agent.terminalId,
    occupantId: occupantIdForHerdrSession(agent.session!),
  }));
  expect(journal.starter(own[0]!.seatId, own[0]!.occupantId)).toMatchObject({
    kind: "app",
    deviceId: "recent",
    channel: "a",
  });
  expect(journal.starter(own[1]!.seatId, own[1]!.occupantId)).toMatchObject({
    kind: "app",
    deviceId: "recent",
    channel: "b",
  });
  const channels = (await expanded()).leads.filter((lead) => lead.appId === "recent");
  expect(
    channels
      .filter((lead) => lead.channel)
      .map((lead) => ({ id: lead.id, channel: lead.channel, hires: lead.hires })),
  ).toEqual([
    { id: "recent:a", channel: "a", hires: [own[0]] },
    { id: "recent:b", channel: "b", hires: [own[1]] },
  ]);
  for (const [index, channel] of ["a", "b"].entries())
    expect(channels.find((lead) => lead.channel === channel)?.touches).toMatchObject([
      { ...own[index], kind: "hire" },
    ]);
  expect(await (await read()).text()).toBe(beforeChannels);
  const cliChannels = await runFleetLeadsCommand(["--json", "--channels"], {
    host: baseUrl,
    env: { CLANKIE_OPERATOR_TOKEN: "owner" },
  });
  expect(cliChannels.leads).toEqual((await expanded()).leads);

  // Native prompt I/O is the boundary seam; authorization and touch recording use the HTTP route.
  await fetch(`${baseUrl}/v1/connector/prompt-answers`, {
    method: "POST",
    headers: { authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "recent", allowed: true }),
  });
  vi.spyOn(f.captain, "answerPrompt").mockResolvedValue({ outcome: "answered", message: "Answered" });
  vi.spyOn(f.captain, "pressKeys").mockResolvedValue({ outcome: "pressed", message: "Pressed" });
  await dispatch({
    op: "prompt_answer",
    appDeviceId: "recent",
    channel: "a",
    terminalId: own[0]!.seatId,
    expect: "Proceed?",
    steps: [{ key: "enter" }],
  });
  await dispatch({
    op: "key_press",
    appDeviceId: "recent",
    channel: "b",
    terminalId: own[1]!.seatId,
    keys: ["esc"],
  });
  expect((await expanded()).leads.find((lead) => lead.id === "recent:a")?.touches?.[0]).toMatchObject({
    ...own[0],
    kind: "answer",
  });
  expect((await expanded()).leads.find((lead) => lead.id === "recent:b")?.touches?.[0]).toMatchObject({
    ...own[1],
    kind: "answer",
  });

  const created = await dispatch(
    {
      op: "create",
      scope: {
        kind: "persona",
        personaId: (await f.captain.fleetRoster!()).agents.find((agent) => agent.seatId === own[0]!.seatId)!
          .personaId,
      },
      title: "Worker",
    },
    "relay",
  );
  f.workerDelivery.mockResolvedValue({ outcome: "delivered", deliveryStage: "consumed" });
  const sent = await dispatch({
    op: "send",
    appDeviceId: "recent",
    channel: "b",
    turn: {
      schemaVersion: 1,
      conversationId: created.conversation.conversationId,
      surfaceClientId: "proof",
      expectedRevision: created.conversation.revision,
      kind: "message",
      message: "Continue the job.",
    },
  });
  expect(sent.result.status).toBe("accepted");
  expect((await expanded()).leads.find((lead) => lead.id === "recent:b")?.touches?.[0]).toMatchObject({
    ...own[0],
    kind: "message",
  });
  const closed = await dispatch({
    op: "close_seat",
    appDeviceId: "recent",
    channel: "b",
    seatId: own[0]!.seatId,
  });
  expect(closed.closed).toBe(true);
  const afterClose = (await expanded()).leads;
  expect(afterClose.find((lead) => lead.id === "recent:b")?.touches?.[0]).toMatchObject({
    ...own[0],
    kind: "close",
  });
  expect(afterClose.find((lead) => lead.id === "recent:a")?.hires).toEqual([]);
  expect(afterClose.find((lead) => lead.id === "recent:b")?.hires).toEqual([own[1]]);

  const relayAuth = new ControlPlaneDeviceAuthorizer({ baseUrl });
  expect((await relayAuth.authorize(token("old"))).authorized).toBe(true);
  let refreshed = (await snapshot()).leads.find((lead) => lead.id === "old")!;
  expect(refreshed).toMatchObject({ active: true, lastActiveAt: iso() });
  const firstSeen = refreshed.lastActiveAt;
  now += 59_999;
  expect((await relayAuth.authorize(token("old"))).authorized).toBe(true);
  expect((await snapshot()).leads.find((lead) => lead.id === "old")!.lastActiveAt).toBe(firstSeen);
  now += 1;
  expect((await relayAuth.authorize(token("old"))).authorized).toBe(true);
  expect((await snapshot()).leads.find((lead) => lead.id === "old")!.lastActiveAt).toBe(iso());
  const seenEvents = (await readFile(eventLogPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((row) => row.type === "device.seen" && row.data.deviceId === "old");
  expect(seenEvents).toHaveLength(3); // one replayed, two real relay auth checks
  const setLead = async (lead: "apps" | "clankie") => {
    const response = await fetch(`${baseUrl}${OPERATOR_CONVERSATION_DISPATCH_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify({ op: "lead", schemaVersion: 1, command: { action: "set", lead } }),
    });
    expect(response.status).toBe(200);
  };
  await setLead("apps");
  expect((await snapshot()).leads[0]!.active).toBe(false);
  const metrics = new TurnMetrics({
    conversationId: "proof",
    lane: "operator",
    runId: "proof",
    acceptedAt: iso(-1000),
  });
  new TurnSettledLog(turnSettledLogPath(f.root)).append(metrics.finish("completed", new Date(now)));
  expect((await snapshot()).leads[0]).toMatchObject({ active: true, lastActiveAt: iso() });
  now += 10 * 60_000;
  expect((await snapshot()).leads[0]!.active).toBe(false);
  await setLead("clankie");
  expect((await snapshot()).leads[0]!.active).toBe(true);
  now += 15 * 60_000;
  expect((await snapshot()).leads.find((lead) => lead.id === "old")!.active).toBe(false);
  now += 5 * 60_000;
  expect((await expanded()).leads.every((lead) => lead.touches?.length === 0)).toBe(true);
  now += 24 * 60 * 60_000;
  const quiet = (await expanded()).leads;
  expect(quiet.find((lead) => lead.id === "recent:a")).toBeUndefined();
  expect(quiet.find((lead) => lead.id === "recent:b")).toMatchObject({
    active: false,
    hires: [own[1]],
    touches: [],
  });
});
