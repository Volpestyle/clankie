import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, expect, it } from "vitest";
import {
  ComputerFrameSchema,
  ComputerLeaseSchema,
  ComputerScreenshotSchema,
  computerPoint,
} from "@clankie/interactive-environment";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { ComputerBody } from "../src/computer-body.ts";
import { registerComputerRoutes } from "../src/computer-http.ts";
import { WindowsComputerHost } from "../src/computer-windows-host.ts";
import { WindowsComputerAdapter, type WindowsComputerObservationClient } from "../src/computer-windows.ts";

// Real page/rendering boundary with the documented native response shape. This
// proves adapter translation and authority, not the Windows native runtime.
class WindowPageFixture implements WindowsComputerObservationClient {
  readonly target = "windows" as const;
  readonly window = { app: "fixture-page", id: 1, title: "Readonly computer fixture" };
  readonly browser: Browser;
  readonly page: Page;
  private frame: string | undefined;
  constructor(browser: Browser, page: Page) {
    this.browser = browser;
    this.page = page;
  }
  async list_apps() {
    return [
      {
        id: this.window.app,
        displayName: "Fixture browser",
        windows: this.page.isClosed() ? [] : [this.window],
      },
    ];
  }
  async get_window_state(input: Parameters<WindowsComputerObservationClient["get_window_state"]>[0]) {
    if (input.window !== this.window || !input.include_screenshot || input.include_text)
      throw new Error("A native returned window and a read-only observation are required");
    const png = await this.page.screenshot({ type: "png" });
    // The page's real CSS viewport is logical geometry, distinct from its PNG scale.
    const viewport = this.page.viewportSize()!;
    this.frame = randomUUID();
    return {
      window: this.window,
      screenshots: [
        {
          id: this.frame,
          url: `data:image/png;base64,${png.toString("base64")}`,
          width: viewport.width,
          height: viewport.height,
          originX: -37,
          originY: 53,
          zIndex: 0,
        },
      ],
      accessibility: null,
    };
  }
}
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "clankie-windows-observation-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const site = new Hono();
  site.get("/", (context) =>
    context.html(
      "<!doctype html><title>Readonly computer fixture</title><style>body{margin:0;background:#123456}h1{color:white}</style><h1>WINDOWS OBSERVATION FIXTURE</h1><button>Untouched</button>",
    ),
  );
  const fixtureServer = serve({ fetch: site.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) =>
    fixtureServer.listening ? resolve() : fixtureServer.once("listening", resolve),
  );
  cleanup.push(() => new Promise<void>((resolve) => fixtureServer.close(() => resolve())));
  const address = fixtureServer.address();
  if (address === null || typeof address === "string") throw new Error("No fixture port");
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CLANKIE_TEST_CHROMIUM ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  cleanup.push(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${address.port}`);
  const client = new WindowPageFixture(browser, page);
  const adapter = new WindowsComputerAdapter(client, "fixture");
  const store = new BodyLeaseStore(join(directory, "lease"));
  cleanup.push(() => store.close());
  const body = new ComputerBody(adapter, store, join(directory, "journal"));
  let granted = true;
  const app = new Hono();
  const bearer = randomUUID();
  registerComputerRoutes(app, {
    body,
    async identity(request, conversationId) {
      if (
        request.headers.get("authorization") !== `Bearer ${bearer}` ||
        conversationId !== "fixture-conversation"
      )
        return undefined;
      return {
        conversationId,
        route: { owner: { conversationId }, mode: "machine" },
        current: () => granted,
        authorize: async () => granted,
      };
    },
  });
  const authorityServer = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) =>
    authorityServer.listening ? resolve() : authorityServer.once("listening", resolve),
  );
  cleanup.push(() => new Promise<void>((resolve) => authorityServer.close(() => resolve())));
  const authorityAddress = authorityServer.address();
  if (authorityAddress === null || typeof authorityAddress === "string")
    throw new Error("No authority HTTP port");
  const host = new WindowsComputerHost({
    sky: client,
    machineId: "fixture",
    conversationId: "fixture-conversation",
    directory: join(directory, "native"),
    authorityURL: `http://127.0.0.1:${authorityAddress.port}`,
  });
  cleanup.push(() => host.close());
  const server = serve({ fetch: host.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = server.address();
  if (port === null || typeof port === "string") throw new Error("No computer HTTP port");
  const request = async (path: string, data: unknown, token: string = bearer) =>
    fetch(`http://127.0.0.1:${port.port}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  const call = async (command: unknown) => {
    const response = await request("/v1/computer", { conversationId: "fixture-conversation", command });
    return { status: response.status, data: await response.json() };
  };
  const acquired = await call({ action: "acquire" });
  const lease = ComputerLeaseSchema.parse(acquired.data.lease);
  const capture = () =>
    call({
      action: "capture",
      leaseId: lease.leaseId,
      target: { appId: client.window.app, windowId: String(client.window.id) },
    });
  return {
    adapter,
    client,
    lease,
    call,
    capture,
    request,
    revoke: () => {
      granted = false;
    },
  };
}

it("observes real page pixels over computer HTTP with exact native window and scaled bounds; refuses input", async () => {
  const f = await fixture();
  const inventory = await f.call({ action: "inventory", leaseId: f.lease.leaseId });
  expect(inventory.data).toMatchObject({
    bodyId: "windows:fixture:console",
    complete: false,
    windows: [{ appId: "fixture-page", windowId: "1" }],
  });
  const first = ComputerScreenshotSchema.parse((await f.capture()).data);
  expect(first).toMatchObject({
    inputReady: false,
    width: 1600,
    height: 1200,
    coordinates: { bounds: { x: -37, y: 53, width: 800, height: 600 } },
  });
  expect(computerPoint(first, { x: 800, y: 600 })).toEqual({ x: 363, y: 353 });
  const frame = ComputerFrameSchema.parse(
    (await f.call({ action: "frame", leaseId: f.lease.leaseId, screenshotId: first.screenshotId })).data,
  );
  expect(Buffer.from(frame.data, "base64").readUInt32BE(16)).toBe(1600);
  const next = ComputerScreenshotSchema.parse((await f.capture()).data);
  expect(next.screenshotId).not.toBe(first.screenshotId);
  expect(next.sequence).toBe(first.sequence + 1);
  expect(
    (
      await f.call({
        action: "input",
        leaseId: f.lease.leaseId,
        screenshotId: next.screenshotId,
        requestId: randomUUID(),
        inputs: [{ kind: "click", at: { x: 20, y: 20 }, foreground: true }],
      })
    ).status,
  ).toBe(409);
  expect(await f.client.page.locator("button").textContent()).toBe("Untouched");
  expect(await f.adapter.stop(async () => {})).toBe(false);
});

it("refuses a target that the real page has closed and retains the conversation lease", async () => {
  const f = await fixture();
  await f.client.page.close();
  expect((await f.capture()).status).toBe(409);
  expect((await f.call({ action: "status" })).data.lease.conversationId).toBe("fixture-conversation");
});

it("native observation host delegates bearer and conversation authority and rechecks revocation", async () => {
  const f = await fixture();
  const data = { conversationId: "fixture-conversation", action: "effect" };
  expect((await f.request("/v1/computer/authority", data, "wrong-bearer")).status).toBe(401);
  expect((await f.request("/v1/computer/authority", { ...data, conversationId: "other" })).status).toBe(401);
  expect((await f.request("/v1/computer/authority", data)).status).toBe(200);
  f.revoke();
  expect((await f.request("/v1/computer/authority", data)).status).toBe(401);
  expect((await f.capture()).status).toBe(401);
});
