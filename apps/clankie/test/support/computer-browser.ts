import { chromium, type Browser, type Page } from "playwright-core";
import {
  computerPoint,
  type ComputerInput,
  type ComputerScreenshot,
  type ComputerTarget,
} from "@clankie/interactive-environment";
import type { ComputerAdapter, ComputerObservation } from "../../src/computer-body.ts";

/** Integration driver for the real local fixture page; never a product adapter or model arm. */
export class FixtureComputer implements ComputerAdapter {
  readonly bodyId = "fixture:chromium";
  readonly browser: Browser;
  readonly page: Page;
  private constructor(browser: Browser, page: Page) {
    this.browser = browser;
    this.page = page;
  }
  static async launch(url: string): Promise<FixtureComputer> {
    const executablePath =
      process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : process.env.CLANKIE_TEST_CHROMIUM;
    const browser = await chromium.launch({
      ...(executablePath === undefined ? {} : { executablePath }),
      headless: true,
    });
    const context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto(url);
    return new FixtureComputer(browser, page);
  }
  async inventory(guard: () => Promise<void>) {
    await guard();
    return {
      complete: true,
      apps: [{ appId: "fixture-browser", name: "Isolated Chromium" }],
      windows: [{ appId: "fixture-browser", windowId: "1", title: await this.page.title() }],
    };
  }
  async capture(
    target: ComputerTarget,
    mode: "normal" | "classic_read_only",
    guard: () => Promise<void>,
  ): Promise<ComputerObservation> {
    await guard();
    if (target.appId !== "fixture-browser" || target.windowId !== "1")
      throw new Error("Fixture target absent");
    return {
      target,
      png: await this.page.screenshot(),
      coordinates: {
        space: "global_display_points",
        origin: "top_left",
        bounds: { x: 37, y: 53, width: 800, height: 600 },
      },
      inputReady: mode === "normal",
      elements: [],
      reference: this.page,
    };
  }
  async input(
    input: ComputerInput,
    observation: ComputerObservation,
    screenshot: ComputerScreenshot,
    guard: () => Promise<void>,
  ) {
    await guard();
    if (observation.reference !== this.page) throw new Error("Wrong fixture producer");
    const local = (point: { x: number; y: number }) => {
      const mapped = computerPoint(screenshot, point);
      return { x: mapped.x - 37, y: mapped.y - 53 };
    };
    switch (input.kind) {
      case "click": {
        const at = local(input.at);
        await this.page.mouse.click(at.x, at.y, { button: input.button });
        break;
      }
      case "type": {
        const focused = this.page.locator(":focus");
        const response = this.page.waitForResponse(
          (r) => r.url().endsWith("/state") && r.request().method() === "POST",
        );
        if (input.clear) await focused.fill(input.text);
        else await focused.pressSequentially(input.text);
        await response;
        if ((await focused.inputValue()) !== input.text)
          return { outcome: "uncertain" as const, detail: "Receiver readback differs" };
        break;
      }
      case "key":
        await this.page.keyboard.press(input.keys);
        break;
      case "drag": {
        const from = local(input.from),
          to = local(input.to);
        await this.page.mouse.move(from.x, from.y);
        await this.page.mouse.down();
        await this.page.mouse.move(to.x, to.y, { steps: 8 });
        await this.page.mouse.up();
        break;
      }
      case "scroll":
        await this.page.mouse.wheel(
          input.direction === "left" ? -input.amount : input.direction === "right" ? input.amount : 0,
          input.direction === "up" ? -input.amount : input.direction === "down" ? input.amount : 0,
        );
        break;
      case "element":
        return { outcome: "failed" as const, detail: "Fixture has pixels only" };
    }
    return { outcome: "confirmed" as const, detail: "Real isolated fixture input completed" };
  }
  async stop(guard: () => Promise<void>): Promise<boolean> {
    await guard();
    await this.browser.close();
    return !this.browser.isConnected();
  }
}
