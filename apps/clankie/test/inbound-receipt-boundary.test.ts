import { serve } from "@hono/node-server";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createInboundSender } from "../../../integrations/claude-plugin/worker/bin/inbound-receipt.mjs";
import { createInboundSender as createLegacySender } from "./fixtures/inbound-receipt-0.6.2.mjs";
import { createClankieApp } from "../src/app.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "../src/captain/herdr-watch.ts";

interface Claim {
  deliveryId: string;
  binding: string;
  fingerprint: string;
  text: string;
}

/** External Herdr observation fixture; HTTP, captain, durable fences and both clients are real. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inbound-receipt-boundary-"));
  const directory = join(root, "client");
  const agent: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "fixture-seat",
    agent: "codex",
    status: "working",
    title: "Receipt boundary fixture",
    session: { source: "herdr:codex", kind: "id", value: "fixture-native-1" },
  };
  const runner: HerdrWatchRunner = {
    get: async (pane) => {
      if (pane !== agent.paneId) throw new Error("Unknown fixture native pane");
      return agent;
    },
    resolveTerminal: async (id) => (id === agent.terminalId ? agent : undefined),
    wait: async () => agent,
  };
  const open = async () => {
    const captain = createCaptain({ herdrAvailable: () => false } as CaptainDeps, {
      repoRoot: root,
      stateDir: root,
      nativeHerdrRunner: runner,
      settings: new SettingsStore(join(root, "settings.json")),
    });
    const service = await createClankieApp({
      captain,
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === "Bearer receipt-fixture"
          ? { operatorId: "fixture-owner" }
          : undefined,
    });
    return { captain, service };
  };
  let running = await open();
  const posts: unknown[] = [];
  // Reproduce a pre-dispatch HTTP outage. The old bridge retains its attempted
  // original; the real service has neither accepted it nor seen its payload.
  let refusePost = true;
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.method === "POST") {
        posts.push(await request.clone().json());
        if (refusePost) return Response.json({ error: "fixture_before_dispatch" }, { status: 503 });
      }
      return running.service.app.fetch(request);
    },
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture has no TCP address");
  const url = `http://127.0.0.1:${address.port}/v1/fleet/seats/${encodeURIComponent(agent.paneId)}/messages`;
  const options = (authorization = "Bearer receipt-fixture") => ({
    directory,
    scope: JSON.stringify(["fixture-herdr.sock", agent.paneId]),
    request: (suffix: string, init?: { method: string; body: string; redirect?: "error" }) =>
      fetch(`${url}${suffix}`, {
        ...init,
        headers: { authorization, "content-type": "application/json" },
        signal: AbortSignal.timeout(5_000),
      }),
  });
  const claim = async (): Promise<Claim> => {
    const file = (await readdir(directory)).find((name) => name.endsWith(".json"));
    if (!file) throw new Error("Fixture expected an unresolved claim");
    return JSON.parse(await readFile(join(directory, file), "utf8"));
  };
  return {
    root,
    directory,
    posts,
    options,
    claim,
    url,
    allowPost: () => {
      refusePost = false;
    },
    async restart() {
      running.service.close();
      await running.captain.close();
      running = await open();
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        if ("closeAllConnections" in server) server.closeAllConnections();
      });
      running.service.close();
      await running.captain.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("settles the old bridge's sealed unknown original through HTTP after service replacement, without a replacement POST", async () => {
  // Exact 0.6.2 source, captured from de02000d. This historical client rejected
  // truthful terminal negatives even after the service sealed the original ID.
  const historical = await readFile(
    fileURLToPath(new URL("./fixtures/inbound-receipt-0.6.2.mjs", import.meta.url)),
  );
  expect(createHash("sha256").update(historical).digest("hex")).toBe(
    "1e6b6fa308021d87242fb340d85bdbed4724323b8d7eef5909bb2dda0a1d2ae6",
  );
  const f = await fixture();
  try {
    const old = createLegacySender(f.options());
    const original = await old("Original report");
    expect(original.deliveryStage).toBe("uncertain");
    const retained = await f.claim();
    expect(f.posts).toHaveLength(1);
    expect(await old("Different follow-up")).toMatchObject({
      deliveryStage: "uncertain",
      deliveryId: retained.deliveryId,
    });
    expect(await f.claim()).toEqual(retained);
    const fencePath = join(f.root, "delivery-receipts", "inbound.json");
    const terminal = JSON.parse(await readFile(fencePath, "utf8"));
    expect(terminal[`id:${retained.deliveryId}`]).toMatchObject({
      notSent: true,
      sessionId: retained.binding,
      fingerprint: retained.fingerprint,
    });
    await f.restart();
    const refreshed = createInboundSender(f.options());
    expect(await refreshed("Different follow-up")).toMatchObject({
      received: false,
      deliveryStage: "unavailable",
      definitive: "not_sent",
      deliveryId: retained.deliveryId,
      detail: "The original was not sent. No replacement was sent.",
    });
    expect(await readdir(f.directory)).toEqual([]);
    expect(f.posts).toHaveLength(1);
    expect(JSON.parse(await readFile(fencePath, "utf8"))).toEqual(terminal);
    // A delayed old request cannot sneak in after the refreshed client releases
    // its claim. This POST simulates an in-flight original, never client replay.
    f.allowPost();
    const delayed = await fetch(f.url, {
      method: "POST",
      headers: { authorization: "Bearer receipt-fixture", "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        text: retained.text,
        delivery: { id: retained.deliveryId, binding: retained.binding },
      }),
    });
    expect(delayed.status).toBe(200);
    expect(await delayed.json()).toMatchObject({
      received: false,
      definitive: "not_sent",
      deliveryId: retained.deliveryId,
    });
    const metadata = JSON.parse(
      await readFile(join(f.root, "conversations/global-default/meta.json"), "utf8"),
    );
    expect(metadata.inboundAcceptances?.[retained.deliveryId]).toBeUndefined();
  } finally {
    await f.close();
  }
});

it.each(["authorization", "binding", "fingerprint"] as const)(
  "keeps the original claim when its HTTP receipt read has mismatched %s",
  async (mismatch) => {
    const f = await fixture();
    try {
      expect((await createLegacySender(f.options())("Original report")).deliveryStage).toBe("uncertain");
      const retained = await f.claim();
      const options = f.options(mismatch === "authorization" ? "Bearer another-owner" : undefined);
      const unproven = createInboundSender({
        ...options,
        request: (suffix, init) => {
          const path = new URL(suffix, "http://fixture.invalid");
          if (mismatch !== "authorization") path.searchParams.set(mismatch, "b".repeat(64));
          return options.request(`${path.pathname}${path.search}`, init);
        },
      });
      expect(await unproven("Different follow-up")).toMatchObject({
        received: false,
        deliveryStage: "uncertain",
        deliveryId: retained.deliveryId,
      });
      expect(await f.claim()).toEqual(retained);
      expect(f.posts).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);
