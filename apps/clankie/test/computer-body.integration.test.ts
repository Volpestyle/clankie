import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import {
  ComputerFrameSchema,
  ComputerLeaseSchema,
  ComputerReceiptSchema,
  ComputerScreenshotSchema,
} from "@clankie/interactive-environment";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { ComputerBody } from "../src/computer-body.ts";
import { registerComputerRoutes } from "../src/computer-http.ts";
import { FixtureComputer } from "./support/computer-browser.ts";
import { startFixtureServer } from "../../../scripts/manual/computer-use/fixture-server.mjs";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  options: {
    revokeAfterFirst?: boolean;
    loseTransport?: boolean;
    expireAfterFirst?: boolean;
    revokeLeaseAfterFirst?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "clankie-computer-integration-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const grants = new Set(["conversation-a", "conversation-b"]);
  let driver: FixtureComputer;
  let revoke: (() => Promise<void>) | undefined;
  const site = await startFixtureServer(directory, {
    onFirstInput: async () => {
      if (options.revokeAfterFirst) grants.delete("conversation-a");
      if (options.revokeLeaseAfterFirst) await revoke?.();
      if (options.loseTransport) await driver.page.close();
      if (options.expireAfterFirst) await new Promise((resolve) => setTimeout(resolve, 1100));
    },
  });
  cleanup.push(() => site.close());
  driver = await FixtureComputer.launch(site.url + "/boundary/lease-revocation");
  cleanup.push(() => driver.close());
  const store = new BodyLeaseStore(join(directory, "lease"));
  cleanup.push(() => store.close());
  const body = new ComputerBody(driver, store, join(directory, "journal"));
  const bearer = randomUUID();
  const app = new Hono();
  registerComputerRoutes(app, {
    body,
    async identity(request, conversationId) {
      if (request.headers.get("authorization") !== `Bearer ${bearer}` || !grants.has(conversationId))
        return undefined;
      return {
        conversationId,
        route: { owner: { conversationId }, mode: "machine" },
        current: () => grants.has(conversationId),
        authorize: async () => grants.has(conversationId),
      };
    },
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture HTTP port");
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        if ("closeAllConnections" in server) server.closeAllConnections();
      }),
  );
  const call = async (command: unknown, conversationId = "conversation-a", token: string = bearer) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/computer`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ conversationId, command }),
    });
    return { status: response.status, data: (await response.json()) as Record<string, unknown> };
  };
  const acquired = await call({ action: "acquire", ...(options.expireAfterFirst ? { ttlMs: 1000 } : {}) });
  const lease = ComputerLeaseSchema.parse(acquired.data.lease);
  revoke = async () => {
    expect((await call({ action: "revoke", leaseId: lease.leaseId })).data.outcome).toBe("revoked");
  };
  const capture = async (mode = "normal") =>
    ComputerScreenshotSchema.parse(
      (
        await call({
          action: "capture",
          leaseId: lease.leaseId,
          target: { appId: "fixture-browser", windowId: "1" },
          capture: mode,
        })
      ).data,
    );
  const input = async (screenshotId: string, inputs: unknown[], requestId = randomUUID()) =>
    call({ action: "input", leaseId: lease.leaseId, screenshotId, requestId, inputs });
  return {
    directory,
    driver,
    site,
    store,
    body,
    grants,
    call,
    lease,
    capture,
    input,
    bearer,
    host: `http://127.0.0.1:${address.port}`,
  };
}

describe("computer contract across real HTTP, Chromium, PNG and lease files", () => {
  it("accepts an authenticated lease revocation while a real input is in flight and refuses the next input", async () => {
    const f = await fixture({ revokeLeaseAfterFirst: true });
    await f.driver.page.locator("#first").focus();
    const image = await f.capture();
    const receipt = ComputerReceiptSchema.parse(
      (
        await f.input(image.screenshotId, [
          { kind: "type", text: "first", clear: true },
          { kind: "key", keys: "Tab" },
          { kind: "type", text: "second", clear: true },
        ])
      ).data,
    );
    expect(receipt.outcome).toBe("failed");
    expect(receipt.inputs.map((i) => i.outcome)).toEqual(["confirmed", "failed"]);
    expect((await f.site.state()).fields).toEqual(["first", ""]);
    expect(f.store.status("computer")?.state).toBe("recovery_required");
    expect((await f.call({ action: "release", leaseId: f.lease.leaseId })).data.reason).toBe(
      "recovery_required",
    );
    expect((await f.call({ action: "recover" })).data.outcome).toBe("released");
  });

  it("delivers the real CLI's frame as a private PNG file without printing image bytes or overwriting a file", async () => {
    const f = await fixture();
    const image = await f.capture();
    const path = join(f.directory, "cli-frame.png");
    const request = JSON.stringify({
      conversationId: "conversation-a",
      command: { action: "frame", leaseId: f.lease.leaseId, screenshotId: image.screenshotId },
    });
    const args = [
      fileURLToPath(new URL("../../tui/bin/clankie.ts", import.meta.url)),
      "computer",
      "request",
      request,
      "--image-path",
      path,
    ];
    const env = { ...process.env, CLANKIE_OPERATOR_TOKEN: f.bearer, CLANKIE_CONTROL_PLANE_URL: f.host };
    const response = await promisify(execFile)(process.execPath, args, { env });
    const metadata = JSON.parse(response.stdout);
    expect(metadata.imagePath).toBe(path);
    expect(metadata.sha256).toBe(image.sha256);
    expect(metadata).not.toHaveProperty("data");
    expect((await readFile(path)).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    await expect(promisify(execFile)(process.execPath, args, { env })).rejects.toThrow();
  });

  it("refuses out-of-frame input before dispatch and invalidates captures even when a new capture fails", async () => {
    const f = await fixture();
    const image = await f.capture();
    const receipt = ComputerReceiptSchema.parse(
      (
        await f.input(image.screenshotId, [
          { kind: "click", at: { x: image.width, y: 0 } },
          { kind: "type", text: "unwanted", clear: true },
        ])
      ).data,
    );
    expect(receipt.outcome).toBe("failed");
    expect(receipt.inputs).toHaveLength(1);
    expect((await f.site.state()).events).toEqual([]);
    const fresh = await f.capture();
    expect(
      (
        await f.call({
          action: "capture",
          leaseId: f.lease.leaseId,
          target: { appId: "missing-app", windowId: "1" },
        })
      ).status,
    ).toBe(409);
    expect((await f.input(fresh.screenshotId, [{ kind: "key", keys: "Tab" }])).status).toBe(409);
    expect((await f.call({ action: "release", leaseId: f.lease.leaseId })).data.outcome).toBe("released");
  });

  it("expires a real driver lease between inputs and keeps it held until host-confirmed stop", async () => {
    const f = await fixture({ expireAfterFirst: true });
    await f.driver.page.locator("#first").focus();
    const image = await f.capture();
    const receipt = ComputerReceiptSchema.parse(
      (
        await f.input(image.screenshotId, [
          { kind: "type", text: "first", clear: true },
          { kind: "key", keys: "Tab" },
          { kind: "type", text: "second", clear: true },
        ])
      ).data,
    );
    expect(receipt.outcome).toBe("failed");
    expect(receipt.inputs.map((i) => i.outcome)).toEqual(["confirmed", "failed"]);
    expect((await f.site.state()).fields).toEqual(["first", ""]);
    expect(f.store.status("computer")?.state).toBe("recovery_required");
    expect((await f.call({ action: "acquire" }, "conversation-b")).data.outcome).toBe("busy");
    expect((await f.call({ action: "recover" }, "conversation-b")).data.outcome).toBe("released");
  });
  it("binds authority and driver, separates media, maps retina pixels and orders real inputs exactly once", async () => {
    const f = await fixture();
    expect((await f.call({ action: "status" }, "conversation-a", "wrong-token")).status).toBe(401);
    expect((await f.call({ action: "acquire" }, "conversation-b")).data.outcome).toBe("busy");
    expect((await f.call({ action: "inventory", leaseId: f.lease.leaseId }, "conversation-b")).status).toBe(
      409,
    );
    const inventory = await f.call({ action: "inventory", leaseId: f.lease.leaseId });
    expect(inventory.data.windows).toEqual([
      { appId: "fixture-browser", windowId: "1", title: "Lease revocation" },
    ]);
    const old = await f.capture();
    const image = await f.capture();
    expect(image.screenshotId).not.toBe(old.screenshotId);
    expect([image.width, image.height]).toEqual([1600, 1200]);
    expect(image).not.toHaveProperty("data");
    const frame = ComputerFrameSchema.parse(
      (await f.call({ action: "frame", leaseId: f.lease.leaseId, screenshotId: image.screenshotId })).data,
    );
    expect(frame.sha256).toBe(image.sha256);
    expect((await f.input(old.screenshotId, [{ kind: "key", keys: "Tab" }])).status).toBe(409);
    const box = await f.driver.page.locator("#first").boundingBox();
    if (!box) throw new Error("Fixture field missing");
    const inputs = [
      { kind: "click", at: { x: (box.x + 20) * 2, y: (box.y + 20) * 2 } },
      { kind: "type", text: "first", clear: true },
      { kind: "key", keys: "Tab" },
      { kind: "type", text: "second", clear: true },
    ];
    const requestId = randomUUID();
    const response = await f.input(image.screenshotId, inputs, requestId);
    const receipt = ComputerReceiptSchema.parse(response.data);
    expect(receipt.outcome).toBe("confirmed");
    expect(receipt.inputs.map((i) => i.index)).toEqual([0, 1, 2, 3]);
    expect((await f.site.state()).fields).toEqual(["first", "second"]);
    expect((await f.input(image.screenshotId, inputs, requestId)).data).toEqual(receipt);
    expect((await f.site.state()).events).toEqual(["field", "field"]);
    expect((await f.input(image.screenshotId, [{ kind: "key", keys: "Tab" }], requestId)).status).toBe(409);
    expect((await f.input(image.screenshotId, inputs)).status).toBe(409);
    const journal = JSON.parse(await readFile(join(f.directory, "journal/computer-inputs.json"), "utf8"));
    expect(journal.requests[requestId].receipt).toEqual(receipt);
    expect((await f.call({ action: "release", leaseId: f.lease.leaseId })).data.outcome).toBe("released");
  });

  it("refuses read-only captures and stops an admitted batch at the revoked conversation boundary", async () => {
    const f = await fixture({ revokeAfterFirst: true });
    const readonly = await f.capture("classic_read_only");
    expect(readonly.inputReady).toBe(false);
    expect((await f.input(readonly.screenshotId, [{ kind: "key", keys: "Tab" }])).status).toBe(409);
    await f.driver.page.locator("#first").focus();
    const image = await f.capture();
    const receipt = ComputerReceiptSchema.parse(
      (
        await f.input(image.screenshotId, [
          { kind: "type", text: "first", clear: true },
          { kind: "key", keys: "Tab" },
          { kind: "type", text: "second", clear: true },
        ])
      ).data,
    );
    expect(receipt.outcome).toBe("failed");
    expect(receipt.inputs.map((i) => i.outcome)).toEqual(["confirmed", "failed"]);
    expect((await f.site.state()).fields).toEqual(["first", ""]);
    expect((await f.call({ action: "status" })).status).toBe(401);
  });

  it("persists uncertainty after a real receiver effect loses transport; recovery proves its own browser stopped", async () => {
    const f = await fixture({ loseTransport: true });
    await f.driver.page.locator("#first").focus();
    const image = await f.capture();
    const inputs = [{ kind: "type", text: "first", clear: true }];
    const requestId = randomUUID();
    const receipt = ComputerReceiptSchema.parse((await f.input(image.screenshotId, inputs, requestId)).data);
    expect(receipt.outcome).toBe("uncertain");
    expect((await f.site.state()).fields).toEqual(["first", ""]);
    expect((await f.input(image.screenshotId, inputs, requestId)).data).toEqual(receipt);
    expect((await f.call({ action: "release", leaseId: f.lease.leaseId })).data.reason).toBe(
      "recovery_required",
    );
    expect((await f.call({ action: "acquire" }, "conversation-b")).data.outcome).toBe("busy");
    expect((await f.call({ action: "recover" }, "conversation-b")).data.outcome).toBe("released");
    expect(f.driver.browser.isConnected()).toBe(false);
  });

  it("quarantines a persisted incarnation on restart without replaying input", async () => {
    const f = await fixture();
    const image = await f.capture();
    f.store.close();
    const restarted = new BodyLeaseStore(join(f.directory, "lease"));
    cleanup.push(() => restarted.close());
    const body = new ComputerBody(f.driver, restarted, join(f.directory, "journal"));
    const identity = {
      conversationId: "conversation-a",
      route: { owner: { conversationId: "conversation-a" }, mode: "machine" as const },
      current: () => true,
      authorize: async () => true,
    };
    expect(restarted.status("computer")?.state).toBe("recovery_required");
    await expect(
      body.dispatch(identity, {
        action: "input",
        leaseId: f.lease.leaseId,
        screenshotId: image.screenshotId,
        requestId: randomUUID(),
        inputs: [{ kind: "key", keys: "Tab" }],
      }),
    ).rejects.toThrow("Stale computer lease");
    expect(((await body.dispatch(identity, { action: "acquire" })) as { outcome: string }).outcome).toBe(
      "busy",
    );
    expect((await f.site.state()).events).toEqual([]);
    expect(((await body.dispatch(identity, { action: "recover" })) as { outcome: string }).outcome).toBe(
      "released",
    );
  });
});
