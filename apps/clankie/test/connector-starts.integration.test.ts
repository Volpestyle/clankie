// Real HTTP dispatch -> operator service -> service-owned start -> Codex adapter -> native
// JSON-RPC/rollout fixture. The allocation seam replaces Herdr/checkout preparation; the
// external Codex server uses the installed protocol fixture, without running a paid model.
// A start with notify wakes its lead through the real lead-wakes path and credential store,
// at a real local webhook (#725).
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { FileCredentialStore, setLeadWake } from "@clankie/credential-broker";
import { ClankieSettingsSchema, emptySettings } from "@clankie/settings";
import {
  OperatorConversationServiceRequestSchema,
  type OperatorConversationServiceRequest,
} from "@clankie/protocol";
import { createCaptainConversationDispatch } from "../../relay/src/conversation-upstream.ts";
import {
  createOperatorService,
  type CreateOperatorServiceContext,
} from "../src/captain/captain-operator-service.ts";
import type { HireSeat } from "../src/captain/port.ts";
import { captureConversationAuthority } from "../src/captain/conversation-owner.ts";
import { startCodexAppServerSeat } from "../src/captain/codex-app-server.ts";
import { createCodexSeatAdapter } from "../src/captain/codex-seat-adapter.ts";
import { codex0160Protocol } from "./fixtures/codex-0160-protocol.ts";
import { createLeadWakes, type LeadWakes } from "../src/lead-wakes.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A lead's wake webhook, stored the way `clankie connector wake set duet` stores it. */
async function wakeHook() {
  const root = await mkdtemp(join(tmpdir(), "start-wake-"));
  const store = new FileCredentialStore(join(root, "credentials.json"));
  const key = `rk_${randomBytes(12).toString("hex")}`;
  const fires: Array<{ authorization: string | undefined; body: Record<string, unknown> }> = [];
  const webhook = createServer((request: IncomingMessage, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      fires.push({
        authorization: request.headers.authorization,
        body: JSON.parse(body) as Record<string, unknown>,
      });
      response.statusCode = 200;
      response.end();
    });
  });
  webhook.listen(0, "127.0.0.1");
  await once(webhook, "listening");
  await setLeadWake(store, "duet", {
    url: `http://127.0.0.1:${(webhook.address() as AddressInfo).port}/v1/routines/duet/fire`,
    authorization: key,
  });
  const wakes = createLeadWakes({ store });
  return {
    wakes,
    key,
    fires,
    close: async () => {
      wakes.close();
      webhook.closeAllConnections();
      await new Promise<void>((resolve) => webhook.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function fixture(failure?: Awaited<ReturnType<HireSeat>>, leadWakes?: LeadWakes) {
  const root = await mkdtemp(join(tmpdir(), "connector-start-"));
  const native = await codex0160Protocol(root);
  const entered = gate();
  const allocate = gate();
  const deliver = gate();
  const finished = gate();
  let launches = 0;
  let closed = false;
  const adapter = createCodexSeatAdapter({
    server: native.launch,
    start: async (options) => {
      options.onThreadPending?.();
      return startCodexAppServerSeat(options);
    },
    trackerOverrides: async () => [],
    desktop: { owns: () => true, report: async () => {}, gone: () => () => {} },
  });
  const settings = ClankieSettingsSchema.parse({
    ...emptySettings(),
    machines: [{ id: "pc", ssh: "test@pc", shell: "posix" }],
    execution: {
      ...emptySettings().execution,
      connections: [
        { id: "pc", machine: "pc", session: "default", ssh: { host: "test@pc", shell: "posix" } },
      ],
    },
    projects: {
      projects: [
        {
          id: "proof",
          name: "proof",
          workspaces: [{ id: "pc", machineId: "pc", platform: "posix", path: root }],
        },
      ],
    },
  });
  let closeSeat: (() => Promise<void>) | undefined;
  const recorded = new Set<string>();
  const context = {
    shutdown: new AbortController(),
    personas: { ready: async () => {} },
    settingsStore: {},
    settings: async () => settings,
    conversations: { runsCaptainTurns: () => true },
    herdrWatches: { nextFreshIntent: () => undefined, hiredSeat: (seatId: string) => recorded.has(seatId) },
    connectorStartsPath: join(root, "connector-starts.json"),
    deps: {
      fleets: { remoteWorkspace: async () => true },
      ...(leadWakes === undefined ? {} : { leadWakes }),
    },
    hireSeat: async (...args: Parameters<HireSeat>) => {
      const [_seat, brief, source] = args;
      launches++;
      entered.resolve();
      await allocate.promise;
      if (failure !== undefined) {
        finished.resolve();
        return failure;
      }
      // This is the same authority capture used by createHiring; HTTP cancellation
      // never enters the service-owned authority or its native dispatch guard.
      const authority = captureConversationAuthority(source);
      authority.onHirePane?.("pc/term_proof");
      const started = await adapter.start(
        { harness: "codex", cwd: root, brief: brief ?? "" },
        {
          paneId: "pc/term_proof",
          waitForStartup: true,
          run: async () => {
            native.startView();
          },
          guard: async () => {
            if (!authority.current()) throw Error("authority lost");
          },
          bound: async () => {
            await deliver.promise;
          },
        },
      );
      if (started.outcome === "started") closeSeat = () => started.control.close();
      finished.resolve();
      if (started.outcome !== "started") throw Error(JSON.stringify(started));
      return { outcome: "spawned", seat: { seatId: "pc/term_proof" } };
    },
  };
  const serve = createOperatorService(context as unknown as CreateOperatorServiceContext);
  const http = createServer(async (req, res) => {
    const abort = new AbortController();
    res.on("close", () => {
      closed = true;
      abort.abort();
    });
    try {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      const request = OperatorConversationServiceRequestSchema.parse(JSON.parse(body));
      const result = await serve(request, undefined, abort.signal);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error("fixture dispatch failed", error);
      res.writeHead(500);
      res.end(String(error));
    }
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const dispatch = createCaptainConversationDispatch({
    baseUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    bearerToken: "proof-bearer-token-000000",
  });
  const request: OperatorConversationServiceRequest = {
    op: "start_agent",
    schemaVersion: 1,
    machine: "pc",
    workingDirectory: root,
    harness: "codex",
    appDeviceId: "connector-proof",
    prompt: "Deliver this original task once.",
  };
  return {
    dispatch,
    request,
    // The same state directory under a new service, as after `clankie update`.
    restart: () => createOperatorService(context as unknown as CreateOperatorServiceContext),
    recorded,
    native,
    entered,
    allocate,
    deliver,
    finished,
    launches: () => launches,
    disconnected: () => closed,
    close: async () => {
      allocate.resolve();
      deliver.resolve();
      if (launches) await finished.promise;
      await closeSeat?.();
      await native.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("keeps the accepted brief after the HTTP caller disconnects mid-hire and delivers it once", async () => {
  const f = await fixture();
  try {
    const abort = new AbortController();
    const response = f.dispatch(f.request, abort.signal);
    const failed = expect(response).rejects.toThrow();
    await f.entered.promise;
    abort.abort();
    await failed;
    await expect.poll(f.disconnected).toBe(true);
    f.allocate.resolve();
    f.deliver.resolve();
    await f.finished.promise;
    expect(f.launches()).toBe(1);
    expect(f.native.requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
    expect(JSON.stringify(f.native.requests.filter((r) => r.method === "turn/start")[0]?.params)).toContain(
      "Deliver this original task once.",
    );
  } finally {
    await f.close();
  }
});

it("returns the allocated pane pending before native readiness and status reads never replay the brief", async () => {
  const f = await fixture();
  try {
    f.allocate.resolve();
    const began = Date.now();
    const result = await f.dispatch(f.request);
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(result).toMatchObject({
      op: "start_agent",
      status: "pending",
      seatId: "pc/term_proof",
      startId: expect.any(String),
    });
    if (result.op !== "start_agent" || !result.startId) throw Error("missing start receipt");
    const read: OperatorConversationServiceRequest = {
      op: "start_agent",
      schemaVersion: 1,
      startId: result.startId,
      appDeviceId: "connector-proof",
    };
    for (let i = 0; i < 2; i++)
      expect(await f.dispatch(read)).toMatchObject({ status: "pending", seatId: "pc/term_proof" });
    expect(await f.dispatch({ ...read, appDeviceId: "another-app" })).toMatchObject({ status: "refused" });
    expect(f.native.requests.filter((r) => r.method === "turn/start")).toHaveLength(0);
    f.deliver.resolve();
    await f.finished.promise;
    await expect.poll(async () => ((await f.dispatch(read)) as { status: string }).status).toBe("started");
    await f.dispatch(read);
    expect(f.launches()).toBe(1);
    expect(f.native.requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("answers a finished hire's receipt after a service restart, to its caller only, without replaying it", async () => {
  const f = await fixture();
  try {
    f.allocate.resolve();
    f.deliver.resolve();
    const result = await f.dispatch(f.request);
    if (result.op !== "start_agent" || !result.startId) throw Error("missing start receipt");
    const read: OperatorConversationServiceRequest = {
      op: "start_agent",
      schemaVersion: 1,
      startId: result.startId,
      appDeviceId: "connector-proof",
    };
    await expect.poll(async () => ((await f.dispatch(read)) as { status: string }).status).toBe("started");
    const restarted = f.restart();
    expect(await restarted(read, undefined, undefined)).toMatchObject({
      status: "started",
      seatId: "pc/term_proof",
      startId: result.startId,
    });
    expect(await restarted({ ...read, appDeviceId: "another-app" }, undefined, undefined)).toMatchObject({
      status: "refused",
      detail: expect.stringContaining("unavailable"),
    });
    expect(f.launches()).toBe(1);
  } finally {
    await f.close();
  }
});

it("resolves a start the restart cut off from the hire records, and names its pane when none is recorded", async () => {
  const f = await fixture();
  try {
    f.allocate.resolve();
    const result = await f.dispatch(f.request);
    if (result.op !== "start_agent" || !result.startId) throw Error("missing start receipt");
    expect(result).toMatchObject({ status: "pending", seatId: "pc/term_proof" });
    const read: OperatorConversationServiceRequest = {
      op: "start_agent",
      schemaVersion: 1,
      startId: result.startId,
      appDeviceId: "connector-proof",
    };
    const restarted = f.restart();
    const unrecorded = await restarted(read, undefined, undefined);
    expect(unrecorded).toMatchObject({ status: "refused", seatId: "pc/term_proof" });
    expect(unrecorded).toMatchObject({ detail: expect.stringContaining("pane pc/term_proof") });
    f.recorded.add("pc/term_proof");
    expect(await restarted(read, undefined, undefined)).toMatchObject({
      status: "started",
      seatId: "pc/term_proof",
    });
  } finally {
    await f.close();
  }
});

it("returns a pending receipt within five seconds even before checkout allocation finishes", async () => {
  const f = await fixture();
  try {
    const began = Date.now();
    const result = await f.dispatch(f.request);
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(result).toMatchObject({ status: "pending", startId: expect.any(String) });
    expect(result).not.toHaveProperty("seatId");
  } finally {
    await f.close();
  }
});

it("an uncertain start names its original receipt even when the service explains it (#326)", async () => {
  const receiptId = "7bc84098-366b-4058-85e2-f8a2a3f6a375";
  const f = await fixture({
    outcome: "failed",
    reason: "start_unconfirmed",
    receiptId,
    detail: "fleet pc: herdr workspace create timed out after 45000 ms",
  });
  try {
    f.allocate.resolve();
    // A start that settles inside the pending window answers at once; a later one by its startId.
    const result = await f.dispatch(f.request);
    if (result.op !== "start_agent") throw Error("unexpected answer");
    const read: OperatorConversationServiceRequest = {
      op: "start_agent",
      schemaVersion: 1,
      startId: result.startId ?? "",
      appDeviceId: "connector-proof",
    };
    if (result.startId !== undefined)
      await expect.poll(async () => ((await f.dispatch(read)) as { status: string }).status).toBe("refused");
    const refused = (result.startId === undefined ? result : await f.dispatch(read)) as {
      status: string;
      detail?: string;
    };
    expect(refused.status).toBe("refused");
    expect(refused.detail).toContain("workspace create timed out");
    expect(refused.detail).toContain(`Inspect original hire receipt ${receiptId}`);
    expect(f.launches()).toBe(1);
  } finally {
    await f.close();
  }
});

it("a pending hire wakes its notify lead once it starts, with its startId and agent id (#725)", async () => {
  const hook = await wakeHook();
  const f = await fixture(undefined, hook.wakes);
  try {
    f.allocate.resolve();
    const result = await f.dispatch({ ...f.request, notify: { lead: "duet", ref: "thread-725" } });
    expect(result).toMatchObject({ status: "pending", seatId: "pc/term_proof", startId: expect.any(String) });
    if (result.op !== "start_agent" || !result.startId) throw Error("missing start receipt");
    expect(hook.fires).toHaveLength(0);
    f.deliver.resolve();
    await f.finished.promise;
    await expect.poll(() => hook.fires.length).toBe(1);
    const [fire] = hook.fires;
    expect(fire?.authorization).toBe(`Bearer ${hook.key}`);
    expect(fire?.body).toMatchObject({
      source: "clankie",
      kind: "start_finished",
      lead: "duet",
      from: "clankie",
    });
    expect(fire?.body).not.toHaveProperty("reply");
    const text = String(fire?.body.text);
    expect(text).toContain(
      `start=${result.startId} ref=thread-725 outcome=started agent=herdr:pc/term_proof time=`,
    );
    expect(text).toContain('Read read_agent {"agent":"herdr:pc/term_proof"}');
    // The brief stays with the hire; the wake carries only service facts.
    expect(text).not.toContain("Deliver this original task once.");
    // The wake agrees with the receipt a polling lead would have read.
    expect(
      await f.dispatch({
        op: "start_agent",
        schemaVersion: 1,
        startId: result.startId,
        appDeviceId: "connector-proof",
      }),
    ).toMatchObject({ status: "started", seatId: "pc/term_proof" });
    expect(f.launches()).toBe(1);
    expect(f.native.requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
  } finally {
    await f.close();
    await hook.close();
  }
});

it("a pending hire that fails wakes its notify lead with the refusal's reason (#725)", async () => {
  const hook = await wakeHook();
  const f = await fixture(
    {
      outcome: "failed",
      reason: "start_unconfirmed",
      receiptId: "7bc84098-366b-4058-85e2-f8a2a3f6a375",
      detail: "fleet pc: herdr workspace create timed out after 45000 ms",
    },
    hook.wakes,
  );
  try {
    // Allocation is still running when the five-second answer goes back pending.
    const result = await f.dispatch({ ...f.request, notify: { lead: "duet", ref: "thread-725" } });
    expect(result).toMatchObject({ status: "pending", startId: expect.any(String) });
    if (result.op !== "start_agent" || !result.startId) throw Error("missing start receipt");
    expect(hook.fires).toHaveLength(0);
    f.allocate.resolve();
    await f.finished.promise;
    await expect.poll(() => hook.fires.length).toBe(1);
    const text = String(hook.fires[0]?.body.text);
    expect(hook.fires[0]?.body).toMatchObject({ kind: "start_finished", lead: "duet" });
    expect(text).toContain(`start=${result.startId} ref=thread-725 outcome=refused time=`);
    expect(text).not.toContain("agent=");
    expect(text).toMatch(/^reason=".*workspace create timed out.*"$/mu);
    expect(text).toContain(`Read start_agent {"startId":"${result.startId}"}`);
    expect(
      await f.dispatch({
        op: "start_agent",
        schemaVersion: 1,
        startId: result.startId,
        appDeviceId: "connector-proof",
      }),
    ).toMatchObject({ status: "refused" });
  } finally {
    await f.close();
    await hook.close();
  }
});
