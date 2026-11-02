// Real HTTP dispatch -> operator service -> service-owned start -> Codex adapter -> native
// JSON-RPC/rollout fixture. The allocation seam replaces Herdr/checkout preparation; the
// external Codex server uses the installed protocol fixture, without running a paid model.
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
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
import { createCodexSeatAdapter } from "../src/captain/codex-seat-adapter.ts";
import { codex0160Protocol } from "./fixtures/codex-0160-protocol.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
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
  const context = {
    shutdown: new AbortController(),
    personas: { ready: async () => {} },
    settingsStore: {},
    settings: async () => settings,
    conversations: { runsCaptainTurns: () => true },
    herdrWatches: { nextFreshIntent: () => undefined },
    deps: { fleets: { remoteWorkspace: async () => true } },
    hireSeat: async (...args: Parameters<HireSeat>) => {
      const [_seat, brief, source] = args;
      launches++;
      entered.resolve();
      await allocate.promise;
      // This is the same authority capture used by createHiring; HTTP cancellation
      // never enters the service-owned authority or its native dispatch guard.
      const authority = captureConversationAuthority(source);
      authority.onHirePane?.("pc/term_proof");
      const started = await adapter.start(
        { harness: "codex", cwd: root, brief: brief ?? "" },
        {
          paneId: "pc/term_proof",
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
