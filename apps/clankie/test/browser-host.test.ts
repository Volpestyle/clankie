import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserUse, CDP, Page, CellError, type BrowserUseOptions } from "@browser_use/pi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserEnabled, createBrowserHost, type BrowserHost } from "../src/browser-host.ts";
import { startBrowserRecording } from "../src/browser-recording.ts";

vi.mock("../src/browser-recording.ts", () => ({ startBrowserRecording: vi.fn() }));

const logger = { info: vi.fn(), warn: vi.fn() };
const jpeg = Buffer.from("test screenshot bytes");
let stateRoot: string;
let host: BrowserHost | undefined;
const execute = vi.fn(async () => ({ text: "cell result", images: [], targetId: "tab-1" }));
const close = vi.fn(async () => {});
const page = {
  targetId: "tab-1",
  sessionId: "session-1",
  goto: vi.fn(async () => ({ url: "https://example.com", title: "Example" })),
  info: vi.fn(async () => ({ url: "https://example.com", title: "Example" })),
  evaluate: vi.fn(async () => "Page text"),
  snapshot: vi.fn(async () => ({ nodes: [] })),
  screenshot: vi.fn(async () => jpeg),
  cdp: vi.fn(async () => ({})),
  clickAt: vi.fn(async () => {}),
};

beforeEach(async () => {
  vi.clearAllMocks();
  execute.mockImplementation(async () => ({ text: "cell result", images: [], targetId: "tab-1" }));
  stateRoot = await mkdtemp(join(tmpdir(), "clankie-browser-unit-"));
  vi.spyOn(BrowserUse, "create").mockImplementation(async (options: BrowserUseOptions) => {
    const browser = options.browser;
    if (!browser || !("profileDir" in browser) || !browser.profileDir)
      throw new Error("private profile required");
    await writeFile(join(browser.profileDir, "DevToolsActivePort"), "1234\n/devtools/browser/test");
    return { execute, close } as unknown as BrowserUse;
  });
  vi.spyOn(CDP, "connect").mockResolvedValue({
    close: vi.fn(),
    send: vi.fn(async () => ({})),
  } as unknown as CDP);
  vi.spyOn(Page, "attach").mockResolvedValue(page as unknown as Page);
});

afterEach(async () => {
  await host?.close();
  host = undefined;
  vi.restoreAllMocks();
  await rm(stateRoot, { recursive: true, force: true });
});

async function build(idleMs = 60_000) {
  host = await createBrowserHost({ stateRoot, attachmentRoot: stateRoot, logger, idleMs });
  return host;
}
const open = (headed?: boolean) => ({
  schemaVersion: 1 as const,
  tool: "browser_use_open",
  arguments: headed === undefined ? {} : { headed },
});
const code = () => ({
  schemaVersion: 1 as const,
  tool: "browser_use_javascript",
  arguments: { code: "console.log(await page.info())" },
});

describe("browser host", () => {
  it("defaults enabled, with explicit opt-out", () => {
    for (const value of [undefined, "", "true", "yes"]) expect(browserEnabled(value)).toBe(true);
    for (const value of ["0", "false", " Off ", "NO"]) expect(browserEnabled(value)).toBe(false);
  });
  it("exposes the SDK catalog without launching Chrome during discovery", async () => {
    const current = await build();
    expect((await current.catalog()).tools).toContainEqual(
      expect.objectContaining({ name: "browser_use_javascript", requiresShell: true }),
    );
    expect(BrowserUse.create).not.toHaveBeenCalled();
  });
  it("refuses Node execution without host-stamped machine authority, including forged arguments", async () => {
    const current = await build();
    for (const arguments_ of [code().arguments, { ...code().arguments, shell: true }]) {
      expect(await current.call({ ...code(), arguments: arguments_ })).toMatchObject({
        outcome: "refused",
        reason: "approval_required",
      });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(await current.call(code(), undefined, { shell: true })).toMatchObject({
      outcome: "ok",
      content: "cell result",
    });
  });
  it("keeps browser-only evaluation out of the Node REPL", async () => {
    const current = await build();
    const expression = "document.title";
    await current.call({ schemaVersion: 1, tool: "browser_use_evaluate", arguments: { expression } });
    expect(page.evaluate).toHaveBeenCalledWith(expression);
    expect(execute).toHaveBeenCalledTimes(1); // Host-authored initialization only.
  });
  it("reuses a private persistent SDK session and preserves long page text", async () => {
    const current = await build();
    page.evaluate.mockResolvedValueOnce("useful text ".repeat(6000));
    expect(
      await current.call({
        schemaVersion: 1,
        tool: "browser_use_read",
        arguments: { url: "https://example.com" },
      }),
    ).toMatchObject({ content: "useful text ".repeat(6000) });
    await current.call(code(), undefined, { shell: true });
    expect(BrowserUse.create).toHaveBeenCalledTimes(1);
    expect(BrowserUse.create).toHaveBeenCalledWith(
      expect.objectContaining({
        telemetry: false,
        workspace: join(stateRoot, "browser", "workspace"),
        browser: expect.objectContaining({
          profileDir: join(stateRoot, "browser", "profile"),
          headless: true,
        }),
      }),
    );
  });
  it("saves screenshots as hash-bound artifacts", async () => {
    const current = await build();
    const result = await current.call({ schemaVersion: 1, tool: "browser_use_screenshot", arguments: {} });
    const digest = createHash("sha256").update(jpeg).digest("hex");
    expect(result).toMatchObject({
      outcome: "ok",
      artifacts: [{ artifactRef: `sha256:${digest}:browser/${digest}.jpg`, mimeType: "image/jpeg" }],
    });
    expect(await readFile(join(stateRoot, "browser", `${digest}.jpg`))).toEqual(jpeg);
  });
  it("resets the session on headed changes and returns to headless after idle", async () => {
    const current = await build(20);
    await current.call(open());
    await current.call(open(true));
    expect(close).toHaveBeenCalledTimes(1);
    expect(BrowserUse.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ browser: expect.objectContaining({ headless: false }) }),
    );
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    await current.call(open());
    expect(BrowserUse.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ browser: expect.objectContaining({ headless: true }) }),
    );
  });
  it("drains accepted calls before shutdown and rejects later calls", async () => {
    const current = await build();
    const first = current.call(open());
    const second = current.call(code(), undefined, { shell: true });
    const stopped = current.close();
    expect(await current.call(open())).toMatchObject({ outcome: "refused" });
    expect(await first).toMatchObject({ outcome: "ok" });
    expect(await second).toMatchObject({ outcome: "ok" });
    await stopped;
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("reports worker loss without replaying the uncertain cell", async () => {
    const current = await build();
    await current.call(open());
    execute.mockRejectedValueOnce(
      new CellError("worker timed out; bindings reset", { text: "before timeout", images: [] }, true),
    );
    const result = await current.call(code(), undefined, { shell: true });
    expect(result).toMatchObject({
      outcome: "ok",
      isError: true,
      content: expect.stringContaining("Inspect before retrying"),
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("reports missing Chrome as unavailable without crashing service creation", async () => {
    vi.mocked(BrowserUse.create).mockRejectedValueOnce(new Error("Chrome not found"));
    const current = await build();
    expect(await current.call(open())).toMatchObject({
      outcome: "refused",
      reason: "browser_unavailable",
      detail: "Chrome not found",
    });
  });

  it("observes the selected tab even when the cell fails after changing it", async () => {
    const current = await build();
    await current.call(open());
    execute.mockRejectedValueOnce(
      new CellError("after tab switch", { text: "", images: [], targetId: "tab-2" }, false),
    );
    expect(await current.call(code(), undefined, { shell: true })).toMatchObject({ isError: true });
    expect(Page.attach).toHaveBeenLastCalledWith(expect.anything(), "tab-2");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("starts recording after the first navigation and finishes it before closing Chrome", async () => {
    const stopped = vi.fn(async () => {
      expect(close).not.toHaveBeenCalled();
      return "/recording.webm";
    });
    vi.mocked(startBrowserRecording).mockImplementationOnce(async () => {
      expect(page.goto).toHaveBeenCalledWith("https://example.com");
      return { stop: stopped };
    });
    host = await createBrowserHost({
      stateRoot,
      attachmentRoot: stateRoot,
      logger,
      recordSessions: async () => true,
    });
    await host.call({ ...open(), arguments: { url: "https://example.com" } });
    await host.close();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps browsing and cleanup working when recording fails", async () => {
    vi.mocked(startBrowserRecording).mockRejectedValueOnce(new Error("ffmpeg missing"));
    host = await createBrowserHost({
      stateRoot,
      attachmentRoot: stateRoot,
      logger,
      recordSessions: async () => true,
    });
    expect(await host.call(open())).toMatchObject({ outcome: "ok" });
    await host.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "browser.recording.failed" }),
      expect.any(String),
    );
  });

  it("keeps idle cleanup armed after an aborted call", async () => {
    const current = await build(20);
    await current.call(open());
    await current.call(open(), AbortSignal.abort());
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
  it("refuses old tools and unknown arguments before starting a browser", async () => {
    const current = await build();
    expect(await current.call({ schemaVersion: 1, tool: "agent_browser_open", arguments: {} })).toMatchObject(
      { outcome: "refused", reason: "unknown_tool" },
    );
    expect(
      await current.call({ ...open(), arguments: { extraArgs: ["--user-data-dir=/private"] } }),
    ).toMatchObject({ isError: true });
    expect(BrowserUse.create).not.toHaveBeenCalled();
  });
});

it("rechecks the body lease inside the browser queue before any queued effect", async () => {
  const current = await build();
  await current.call(open());
  let release!: () => void;
  let started!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  execute.mockImplementationOnce(async () => {
    started();
    await waiting;
    return { text: "done", images: [], targetId: "tab-1" };
  });
  const first = current.call(code(), undefined, { shell: true });
  await begun;
  let permitted = true;
  const second = current.call(
    { schemaVersion: 1, tool: "browser_use_click", arguments: { x: 10, y: 10 } },
    undefined,
    {
      guard: async () => {
        if (!permitted) throw new Error("stale body lease");
      },
    },
  );
  permitted = false;
  release();
  await first;
  await expect(second).rejects.toThrow("stale body lease");
  expect(page.clickAt).not.toHaveBeenCalled();
});

it("rechecks a body lease after asynchronous browser setup before page actions", async () => {
  const current = await build();
  let allowed = true;
  vi.mocked(Page.attach).mockImplementationOnce(async () => {
    allowed = false;
    return page as unknown as Page;
  });
  const result = await current.call(
    { schemaVersion: 1, tool: "browser_use_click", arguments: { x: 10, y: 10 } },
    undefined,
    {
      guard: async () => {
        if (!allowed) throw new Error("lease changed during browser setup");
      },
    },
  );
  expect(result).toMatchObject({ outcome: "refused", reason: "browser_unavailable" });
  expect(page.clickAt).not.toHaveBeenCalled();
});
