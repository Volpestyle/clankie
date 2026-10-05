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
  ComputerReceiptSchema,
  ComputerScreenshotSchema,
  computerPoint,
} from "@clankie/interactive-environment";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { ComputerBody } from "../src/computer-body.ts";
import { registerComputerRoutes } from "../src/computer-http.ts";
import { WindowsComputerHost } from "../src/computer-windows-host.ts";
import { WindowsComputerAdapter, type WindowsComputerObservationClient } from "../src/computer-windows.ts";

interface NativeFixtureState {
  window: { app: string; id: number; title?: string };
  screenshots: {
    id: string;
    url: string;
    width: number;
    height: number;
    originX: number;
    originY: number;
    zIndex: number;
  }[];
  accessibility: {
    tree: string;
    focused_element: string;
    document_text: string;
    selected_text: string;
    selected_elements: string[];
  } | null;
}

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
  async get_window_state(
    input: Parameters<WindowsComputerObservationClient["get_window_state"]>[0],
  ): Promise<NativeFixtureState> {
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

// Disposable local page only: these methods reproduce the published sky call
// shapes and act on real browser controls. They do not prove Windows native input.
const ACTION_PAGE = `<!doctype html><title>Readonly computer fixture</title>
<style>body{margin:20px;font:16px sans-serif;background:#e9eff5}input,button{display:block;width:300px;height:36px;margin:12px 0}
#viewport{width:300px;height:120px;overflow:auto;border:2px solid #345}.row{height:32px}
#cards{width:300px;padding:0;list-style:none}#cards li{height:38px;margin:3px 0;background:#b8d7f1;touch-action:none}</style>
<label>Draft text<input id="draft" aria-label="Draft text"></label>
<button id="apply" aria-label="Apply draft">Apply draft</button><p id="result">Applied 0</p>
<div id="viewport" aria-label="Scroll region">${Array.from({ length: 30 }, (_, i) => `<div class="row">Row ${i}</div>`).join("")}</div>
<p id="scroll-result">Scroll 0</p><ul id="cards"><li>alpha</li><li>beta</li><li>gamma</li></ul>
<script>
let applies = 0; const draft = document.querySelector('#draft');
document.querySelector('#apply').onclick = () => { document.querySelector('#result').textContent = 'Applied ' + (++applies) + ': ' + draft.value; };
const viewport = document.querySelector('#viewport');
viewport.onscroll = () => { document.querySelector('#scroll-result').textContent = 'Scroll ' + viewport.scrollTop; };
let dragged; for (const card of document.querySelectorAll('#cards li')) {
  card.onpointerdown = () => { dragged = card; };
  card.onpointerup = () => { if (dragged && dragged !== card) card.parentElement.insertBefore(dragged, card); dragged = undefined; };
}
</script>`;

class WindowActionFixture extends WindowPageFixture {
  readonly calls: { method: string; input: Record<string, unknown> }[] = [];
  readonly nativeScreenshots = new Set<string>();
  behavior: "normal" | "lose_receipt" | "interrupted" | "unchanged" | "unrelated" = "normal";
  afterEffect: (() => Promise<void>) | undefined;
  postCapture: "normal" | "reused" | "wrong_window" | "changed_bounds" = "normal";
  typingProbeDrift: "focus" | "text" | undefined;
  private previousScreenshot: string | undefined;

  async fields() {
    return this.page.evaluate(() => {
      const draft = document.querySelector<HTMLInputElement>("#draft")!;
      const cards = [...document.querySelectorAll("#cards li")].map((card) => card.textContent).join(",");
      return {
        tree: `Draft ${draft.value}\n${document.querySelector("#result")!.textContent}\n${document.querySelector("#scroll-result")!.textContent}\nCards ${cards}`,
        focused_element: document.activeElement?.getAttribute("aria-label") ?? "",
        document_text: document.body.innerText,
        selected_text: draft.value.slice(draft.selectionStart ?? 0, draft.selectionEnd ?? 0),
        selected_elements: [],
      };
    });
  }

  override async get_window_state(
    input: Parameters<WindowsComputerObservationClient["get_window_state"]>[0],
  ): Promise<NativeFixtureState> {
    if (!input.include_screenshot) {
      if (this.typingProbeDrift === "focus") await this.page.locator("#apply").focus();
      if (this.typingProbeDrift === "text") await this.page.locator("#draft").fill("Changed before input");
      return { window: this.window, screenshots: [], accessibility: await this.fields() };
    }
    const state = await super.get_window_state({ ...input, include_text: false });
    const shot = state.screenshots[0]!;
    if (this.calls.length && this.postCapture === "reused" && this.previousScreenshot)
      shot.id = this.previousScreenshot;
    if (this.calls.length && this.postCapture === "changed_bounds") shot.width -= 1;
    this.previousScreenshot = shot.id;
    this.nativeScreenshots.add(shot.id);
    return {
      ...state,
      window:
        this.calls.length && this.postCapture === "wrong_window" ? { ...this.window, id: 2 } : state.window,
      accessibility: input.include_text ? await this.fields() : null,
    };
  }

  private async action(method: string, input: Record<string, unknown>, effect: () => Promise<void>) {
    if (input.window !== this.window) throw new Error("Only the exact native inventory window is allowed");
    if (typeof input.screenshotId === "string" && !this.nativeScreenshots.has(input.screenshotId))
      throw new Error("Screenshot must originate from this fixture's real capture");
    this.calls.push({ method, input });
    if (this.behavior === "interrupted") throw new Error("Computer Use reports that the turn ended");
    if (this.behavior === "unrelated")
      await this.page.locator("#result").evaluate((node) => {
        node.textContent = "Unrelated repaint";
      });
    else if (this.behavior !== "unchanged") await effect();
    await this.afterEffect?.();
    if (this.behavior === "lose_receipt")
      throw new Error("RPC connection closed after dispatch: FIXTURE_PRIVATE_NATIVE_DIAGNOSTIC");
  }
  async click(input: {
    window: WindowPageFixture["window"];
    screenshotId: string;
    x: number;
    y: number;
    mouse_button: string;
  }) {
    await this.action("click", input, () =>
      this.page.mouse.click(input.x, input.y, { button: input.mouse_button as "left" | "right" }),
    );
  }
  async press_key(input: { window: WindowPageFixture["window"]; key: string }) {
    await this.action("press_key", input, () => this.page.keyboard.press(input.key));
  }
  async type_text(input: { window: WindowPageFixture["window"]; text: string }) {
    await this.action("type_text", input, () => this.page.keyboard.insertText(input.text));
  }
  async scroll(input: {
    window: WindowPageFixture["window"];
    screenshotId: string;
    x: number;
    y: number;
    scrollX: number;
    scrollY: number;
  }) {
    await this.action("scroll", input, async () => {
      await this.page.mouse.move(input.x, input.y);
      await this.page.mouse.wheel(input.scrollX, input.scrollY);
      await this.page.waitForFunction(() => document.querySelector("#viewport")!.scrollTop > 0);
    });
  }
  async drag(input: {
    window: WindowPageFixture["window"];
    screenshotId: string;
    from_x: number;
    from_y: number;
    to_x: number;
    to_y: number;
  }) {
    await this.action("drag", input, async () => {
      await this.page.mouse.move(input.from_x, input.from_y);
      await this.page.mouse.down();
      await this.page.mouse.move(input.to_x, input.to_y, { steps: 8 });
      await this.page.mouse.up();
    });
  }
}
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(options: { actions?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "clankie-windows-observation-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const site = new Hono();
  site.get("/", (context) =>
    context.html(
      options.actions
        ? ACTION_PAGE
        : "<!doctype html><title>Readonly computer fixture</title><style>body{margin:0;background:#123456}h1{color:white}</style><h1>WINDOWS OBSERVATION FIXTURE</h1><button>Untouched</button>",
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
  const client = options.actions
    ? new WindowActionFixture(browser, page)
    : new WindowPageFixture(browser, page);
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
    host,
    client,
    lease,
    call,
    capture,
    request,
    input: (screenshotId: string, inputs: unknown[], requestId = randomUUID()) =>
      call({ action: "input", leaseId: lease.leaseId, screenshotId, requestId, inputs }),
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

async function actionFixture() {
  const f = await fixture({ actions: true });
  if (!(f.client instanceof WindowActionFixture)) throw new Error("Action fixture not attached");
  const client = f.client;
  return {
    ...f,
    client,
    captureImage: async () => ComputerScreenshotSchema.parse((await f.capture()).data),
    pixel: async (selector: string) => {
      const box = await client.page.locator(selector).boundingBox();
      if (!box) throw new Error("Disposable fixture target absent");
      return { x: (box.x + box.width / 2) * 2, y: (box.y + box.height / 2) * 2 };
    },
  };
}
const expected = (field: "tree" | "focused_element" | "document_text" | "selected_text", equals: string) => ({
  field,
  equals,
});

it("runs native-shaped Windows primitives against real controls, with scaled window-relative coordinates and observed receipts", async () => {
  const f = await actionFixture();
  const run = async (input: unknown) => {
    const image = await f.captureImage();
    expect(image.inputReady).toBe(true);
    expect(image.coordinates.bounds).toEqual({ x: -37, y: 53, width: 800, height: 600 });
    const result = ComputerReceiptSchema.parse((await f.input(image.screenshotId, [input])).data);
    expect(result.outcome).toBe("confirmed");
    expect(result.inputs).toHaveLength(1);
    return image;
  };
  const draft = await f.pixel("#draft");
  await run({
    kind: "click",
    at: draft,
    foreground: true,
    expect: expected("focused_element", "Draft text"),
  });
  expect(f.client.calls[0]).toMatchObject({
    method: "click",
    input: { window: f.client.window, x: draft.x / 2, y: draft.y / 2, mouse_button: "left" },
  });
  expect(f.client.calls[0]!.input.window).toBe(f.client.window);
  const beforeType = await f.client.fields();
  await run({
    kind: "type",
    text: "WINDOWS_FIXTURE_42",
    foreground: true,
    expect: expected("tree", beforeType.tree.replace("Draft \n", "Draft WINDOWS_FIXTURE_42\n")),
  });
  expect(await f.client.page.locator("#draft").inputValue()).toBe("WINDOWS_FIXTURE_42");
  expect(f.client.calls[1]).toEqual({
    method: "type_text",
    input: { window: f.client.window, text: "WINDOWS_FIXTURE_42" },
  });
  await run({
    kind: "key",
    keys: "Tab",
    foreground: true,
    expect: expected("focused_element", "Apply draft"),
  });
  expect(f.client.calls[2]).toEqual({ method: "press_key", input: { window: f.client.window, key: "Tab" } });
  const beforeApply = await f.client.fields();
  await run({
    kind: "click",
    at: await f.pixel("#apply"),
    foreground: true,
    expect: expected("tree", beforeApply.tree.replace("Applied 0", "Applied 1: WINDOWS_FIXTURE_42")),
  });
  expect(await f.client.page.locator("#result").textContent()).toBe("Applied 1: WINDOWS_FIXTURE_42");
  const beforeScroll = await f.client.fields();
  const at = await f.pixel("#viewport");
  await run({
    kind: "scroll",
    at,
    direction: "down",
    amount: 40,
    foreground: true,
    expect: expected("tree", beforeScroll.tree.replace("Scroll 0", "Scroll 40")),
  });
  expect(f.client.calls[4]).toMatchObject({
    method: "scroll",
    input: { x: at.x / 2, y: at.y / 2, scrollX: 0, scrollY: 40 },
  });
  const beforeDrag = await f.client.fields();
  const from = await f.pixel("#cards li:nth-child(3)"),
    to = await f.pixel("#cards li:nth-child(1)");
  await run({
    kind: "drag",
    from,
    to,
    foreground: true,
    expect: expected("tree", beforeDrag.tree.replace("Cards alpha,beta,gamma", "Cards gamma,alpha,beta")),
  });
  expect(f.client.calls[5]).toMatchObject({
    method: "drag",
    input: { from_x: from.x / 2, from_y: from.y / 2, to_x: to.x / 2, to_y: to.y / 2 },
  });
  expect(await f.client.page.locator("#cards li").allTextContents()).toEqual(["gamma", "alpha", "beta"]);
  expect(f.client.calls).toHaveLength(6);
});

it("refuses foreground, missing or already-satisfied proof, invented elements, multi-action clear and invalid capture coordinates before native dispatch", async () => {
  const f = await actionFixture();
  const at = await f.pixel("#draft");
  const valid = { kind: "click", at, foreground: true, expect: expected("focused_element", "Draft text") };
  for (const input of [
    { ...valid, foreground: false },
    { kind: "click", at, foreground: true },
    { ...valid, expect: expected("focused_element", "") },
    { ...valid, expect: expected("tree", (await f.client.fields()).tree) },
    { kind: "type", text: "never", clear: true, foreground: true, expect: expected("tree", "never") },
    { kind: "type", text: "no\ncontrol", foreground: true, expect: expected("tree", "never") },
    { kind: "scroll", direction: "down", amount: 40, foreground: true, expect: expected("tree", "never") },
    { kind: "element", elementId: "guessed-uia-1", foreground: true, expect: expected("tree", "never") },
    { kind: "key", keys: "Win+R", foreground: true, expect: expected("tree", "never") },
    { ...valid, at: { x: 1600, y: 100 } },
  ]) {
    const image = await f.captureImage();
    const response = await f.input(image.screenshotId, [input]);
    expect(response.status).toBe(200);
    expect(ComputerReceiptSchema.parse(response.data).outcome).toBe("failed");
    expect(f.client.calls).toHaveLength(0);
  }
  const old = await f.captureImage();
  await f.captureImage();
  expect((await f.input(old.screenshotId, [valid])).status).toBe(409);
  const latest = await f.captureImage();
  expect(
    (await f.input(latest.screenshotId, [{ ...valid, expect: { field: "caller_assertion", equals: "yes" } }]))
      .status,
  ).toBe(400);
  expect(f.client.calls).toHaveLength(0);
  expect(await f.client.page.locator("#draft").inputValue()).toBe("");
});

it("consumes one native observation per primitive and refuses a batch's second input without dispatch", async () => {
  const f = await actionFixture();
  const image = await f.captureImage();
  const receipt = ComputerReceiptSchema.parse(
    (
      await f.input(image.screenshotId, [
        {
          kind: "click",
          at: await f.pixel("#draft"),
          foreground: true,
          expect: expected("focused_element", "Draft text"),
        },
        {
          kind: "type",
          text: "must not dispatch",
          foreground: true,
          expect: expected("tree", "must not dispatch"),
        },
      ])
    ).data,
  );
  expect(receipt.outcome).toBe("failed");
  expect(receipt.inputs.map((input) => input.outcome)).toEqual(["confirmed", "failed"]);
  expect(f.client.calls).toHaveLength(1);
  expect(await f.client.page.locator("#draft").inputValue()).toBe("");
});

it.each(["focus", "text"] as const)(
  "refuses typing when observed %s changes immediately before dispatch",
  async (drift) => {
    const f = await actionFixture();
    await f.client.page.locator("#draft").focus();
    const image = await f.captureImage();
    expect(image.accessibility?.focused_element).toBe("Draft text");
    f.client.typingProbeDrift = drift;
    const receipt = ComputerReceiptSchema.parse(
      (
        await f.input(image.screenshotId, [
          {
            kind: "type",
            text: "must not dispatch",
            foreground: true,
            expect: expected("tree", "Draft must not dispatch"),
          },
        ])
      ).data,
    );
    expect(receipt.outcome).toBe("failed");
    expect(f.client.calls).toHaveLength(0);
    expect(await f.client.page.locator("#draft").inputValue()).toBe(
      drift === "text" ? "Changed before input" : "",
    );
    expect((await f.client.fields()).focused_element).toBe(drift === "focus" ? "Apply draft" : "Draft text");
  },
);

it("quarantines a real effect whose native receipt is lost and reconciles the UUID without another dispatch", async () => {
  const f = await actionFixture();
  f.client.behavior = "lose_receipt";
  const image = await f.captureImage();
  const requestId = randomUUID();
  const inputs = [
    {
      kind: "click",
      at: await f.pixel("#apply"),
      foreground: true,
      expect: expected("tree", (await f.client.fields()).tree.replace("Applied 0", "Applied 1: ")),
    },
  ];
  const receipt = ComputerReceiptSchema.parse((await f.input(image.screenshotId, inputs, requestId)).data);
  expect(receipt.outcome).toBe("uncertain");
  expect(JSON.stringify(receipt)).not.toContain("FIXTURE_PRIVATE_NATIVE_DIAGNOSTIC");
  expect(await f.client.page.locator("#result").textContent()).toBe("Applied 1: ");
  expect((await f.input(image.screenshotId, inputs, requestId)).data).toEqual(receipt);
  expect((await f.input(image.screenshotId, inputs)).data.reason).toBe("recovery_required");
  expect(f.client.calls).toHaveLength(1);
  expect((await f.call({ action: "status" })).data.lease.state).toBe("recovery_required");
  expect((await f.call({ action: "recover" })).data.reason).toBe("recovery_required");
});

for (const behavior of ["unchanged", "unrelated"] as const) {
  it(`does not confirm a returned native call with ${behavior} UI state`, async () => {
    const f = await actionFixture();
    f.client.behavior = behavior;
    const image = await f.captureImage();
    const receipt = ComputerReceiptSchema.parse(
      (
        await f.input(image.screenshotId, [
          {
            kind: "click",
            at: await f.pixel("#draft"),
            foreground: true,
            expect: expected("focused_element", "Draft text"),
          },
        ])
      ).data,
    );
    expect(receipt.outcome).toBe("uncertain");
    expect(f.client.calls).toHaveLength(1);
    expect((await f.call({ action: "status" })).data.lease.state).toBe("recovery_required");
  });
}

for (const postCapture of ["reused", "wrong_window", "changed_bounds"] as const) {
  it(`requires fresh exact post-action capture proof when the native response is ${postCapture}`, async () => {
    const f = await actionFixture();
    const image = await f.captureImage();
    f.client.postCapture = postCapture;
    const receipt = ComputerReceiptSchema.parse(
      (
        await f.input(image.screenshotId, [
          {
            kind: "click",
            at: await f.pixel("#draft"),
            foreground: true,
            expect: expected("focused_element", "Draft text"),
          },
        ])
      ).data,
    );
    expect(receipt.outcome).toBe("uncertain");
    expect(f.client.calls).toHaveLength(1);
    expect((await f.client.fields()).focused_element).toBe("Draft text");
    expect((await f.call({ action: "status" })).data.lease.state).toBe("recovery_required");
  });
}

for (const boundary of ["authority", "lease"] as const) {
  it(`blocks continued input when ${boundary} is revoked while a native effect is in flight`, async () => {
    const f = await actionFixture();
    const image = await f.captureImage();
    f.client.afterEffect = async () => {
      if (boundary === "authority") f.revoke();
      else
        expect((await f.call({ action: "revoke", leaseId: f.lease.leaseId })).data.outcome).toBe("revoked");
    };
    const receipt = ComputerReceiptSchema.parse(
      (
        await f.input(image.screenshotId, [
          {
            kind: "click",
            at: await f.pixel("#draft"),
            foreground: true,
            expect: expected("focused_element", "Draft text"),
          },
          { kind: "type", text: "must not dispatch", foreground: true, expect: expected("tree", "never") },
        ])
      ).data,
    );
    expect(receipt.outcome).toBe("uncertain");
    expect(f.client.calls).toHaveLength(1);
    expect(await f.client.page.locator("#draft").inputValue()).toBe("");
    const next = await f.capture();
    expect(next.status).toBe(boundary === "authority" ? 401 : 200);
    if (boundary === "lease") expect(next.data.reason).toBe("recovery_required");
  });
}

it("fences a native interrupted turn and retains its lease without claiming stop proof", async () => {
  const f = await actionFixture();
  f.client.behavior = "interrupted";
  const image = await f.captureImage();
  const receipt = ComputerReceiptSchema.parse(
    (
      await f.input(image.screenshotId, [
        {
          kind: "click",
          at: await f.pixel("#draft"),
          foreground: true,
          expect: expected("focused_element", "Draft text"),
        },
      ])
    ).data,
  );
  expect(receipt.outcome).toBe("uncertain");
  expect(f.client.calls).toHaveLength(1);
  expect(f.host.inputReady).toBe(false);
  f.client.behavior = "normal";
  expect((await f.call({ action: "recover" })).data.reason).toBe("recovery_required");
  expect((await f.call({ action: "status" })).data.lease.state).toBe("recovery_required");
  expect(f.client.calls).toHaveLength(1);
});
