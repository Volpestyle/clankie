import { createHash } from "node:crypto";
import { z } from "zod";
import {
  COMPUTER_FRAME_MAX_BYTES,
  ComputerAccessibilitySchema,
  computerPoint,
  type ComputerInput,
  type ComputerScreenshot,
  type ComputerTarget,
} from "@clankie/interactive-environment";
import type { ComputerAdapter, ComputerObservation } from "./computer-body.ts";
import { WindowsPersonActivityGuard, type WindowsLastInputReader } from "./computer-windows-person.ts";

const Window = z.object({
  app: z.string().min(1).max(256),
  id: z.number().int().positive().safe(),
  title: z.string().max(4096).optional(),
});
type NativeWindow = z.infer<typeof Window>;
const Apps = z
  .array(
    z.object({
      id: z.string().min(1).max(256),
      displayName: z.string().min(1).max(256).optional(),
      windows: z.array(Window).max(2048),
    }),
  )
  .max(512);
const Accessibility = ComputerAccessibilitySchema;
const State = z.object({
  window: Window,
  accessibility: Accessibility.nullable().optional(),
  screenshots: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        url: z.string().max(Math.ceil(COMPUTER_FRAME_MAX_BYTES / 3) * 4 + 64),
        width: z.number().finite().positive().max(16384),
        height: z.number().finite().positive().max(16384),
        originX: z.number().finite(),
        originY: z.number().finite(),
      }),
    )
    .length(1),
});

/** Supplied by the native harness's trusted node_repl @oai/sky service.
 * Clankie starts no helper, app, separate model loop or private provider RPC.
 */
export interface WindowsComputerObservationClient {
  readonly target: "windows";
  list_apps(): Promise<unknown>;
  get_window_state(input: {
    window: NativeWindow;
    include_screenshot: boolean;
    include_text: boolean;
  }): Promise<unknown>;
}

/** Documented Windows window2 primitives. Native calls return no effect or stop receipt.
 * Coordinate arguments are window-relative logical pixels, not desktop/image pixels.
 */
interface WindowsComputerActionClient extends WindowsComputerObservationClient {
  click(input: {
    window: NativeWindow;
    screenshotId: string;
    x: number;
    y: number;
    mouse_button: "left" | "right";
  }): Promise<void>;
  press_key(input: { window: NativeWindow; key: string }): Promise<void>;
  type_text(input: { window: NativeWindow; text: string }): Promise<void>;
  scroll(input: {
    window: NativeWindow;
    screenshotId: string;
    x: number;
    y: number;
    scrollX: number;
    scrollY: number;
  }): Promise<void>;
  drag(input: {
    window: NativeWindow;
    screenshotId: string;
    from_x: number;
    from_y: number;
    to_x: number;
    to_y: number;
  }): Promise<void>;
}

type NativeReference = {
  window: NativeWindow;
  screenshotId: string;
  accessibility: z.infer<typeof State>["accessibility"];
  bounds: ComputerScreenshot["coordinates"]["bounds"];
  width: number;
  height: number;
  sha256: string;
};
function actionClient(client: WindowsComputerObservationClient): client is WindowsComputerActionClient {
  return ["click", "press_key", "type_text", "scroll", "drag"].every(
    (method) => typeof Reflect.get(client, method) === "function",
  );
}

const prohibitedApps = new Set([
  "cmd",
  "powershell",
  "pwsh",
  "windowsterminal",
  "conhost",
  "regedit",
  "taskmgr",
  "searchhost",
  "startmenuexperiencehost",
]);
function assertAllowedTarget(window: NativeWindow): void {
  const app = window.app.normalize("NFKC").trim().toLowerCase();
  const basename = app.replaceAll("\\", "/").split("/").at(-1)!.replace(/^"|"$/gu, "");
  const stem = basename.replace(/\.exe$/u, "");
  if (
    prohibitedApps.has(stem) ||
    /(?:^|[.:!_])(?:windowsterminal|searchhost|startmenuexperiencehost)(?:[.:!_]|$)/u.test(app)
  )
    throw new Error("Windows target app is prohibited for computer input and capture");
  if (stem === "explorer" && /^run$/iu.test(window.title?.trim() ?? ""))
    throw new Error("Windows Explorer Run window is prohibited");
}

function allowedKeys(keys: string): boolean {
  if (!/^[A-Za-z0-9_]+(?:\s*\+\s*[A-Za-z0-9_]+)*$/u.test(keys)) return false;
  const tokens = keys
    .toLowerCase()
    .split("+")
    .map((key) => key.trim().replace(/_(?:l|r)$/u, ""));
  if (tokens.some((key) => /^(?:meta|windows?|win|cmd|command|super|os|lwin|rwin)$/u.test(key))) return false;
  const normalized = tokens.map((key) => (key === "ctrl" ? "control" : key === "esc" ? "escape" : key));
  if (normalized.includes("control") && normalized.includes("escape")) return false;
  if (normalized.includes("alt") && (normalized.includes("f4") || normalized.includes("tab"))) return false;
  return true;
}

/** Native app grants and turn stops remain with Codex. One primitive consumes one
 * observation; only a fresh, exact post-action observation proves its named effect.
 * Unsupported/read-only clients retain the observation-only contract.
 */
export class WindowsComputerAdapter implements ComputerAdapter {
  readonly bodyId: string;
  readonly allowInput: boolean;
  private readonly client: WindowsComputerObservationClient;
  private readonly snapshots = new Set<string>();
  private latest: NativeReference | undefined;
  private fenced = false;
  private readonly person: WindowsPersonActivityGuard | undefined;

  constructor(
    client: WindowsComputerObservationClient,
    machineId: string,
    options: { allowInput?: boolean; readLastInput?: WindowsLastInputReader } = {},
  ) {
    if (client.target !== "windows" || !/^[a-z][a-z0-9-]{0,63}$/u.test(machineId))
      throw new Error("An identified Windows native computer-use host is required");
    this.bodyId = `windows:${machineId}:console`;
    this.client = client;
    this.allowInput = options.allowInput === true;
    if (this.allowInput) {
      if (options.readLastInput === undefined)
        throw new Error("Windows input requires a host last-input reader");
      this.person = new WindowsPersonActivityGuard(options.readLastInput);
    }
  }

  get inputReady(): boolean {
    return this.allowInput && !this.fenced && actionClient(this.client);
  }

  private ensureOpen() {
    if (this.fenced) throw new Error("Windows Computer Use was stopped; this host is fenced");
  }

  private async native<T>(call: () => Promise<T>): Promise<T> {
    this.ensureOpen();
    try {
      return await call();
    } catch {
      // There is no proved native turn-lifecycle signal here. Fence every error,
      // including opaque failures after a turn ended, without parsing diagnostics.
      this.fenced = true;
      this.latest = undefined;
      // Provider diagnostics can contain literal input or UI text. Receipts and
      // the persistent journal retain only this bounded semantic reason.
      throw new Error("Windows native operation failed; this host is fenced");
    }
  }

  private async apps(guard: () => Promise<void>) {
    this.ensureOpen();
    await guard();
    const raw = await this.native(() => this.client.list_apps());
    Apps.parse(raw);
    const apps = raw as z.infer<typeof Apps>; // Preserve the native returned window objects.
    await guard();
    const appIds = new Set<string>();
    const windowIds = new Set<number>();
    for (const app of apps) {
      if (appIds.has(app.id)) throw new Error("Ambiguous native app inventory");
      appIds.add(app.id);
      for (const window of app.windows) {
        if (window.app !== app.id || windowIds.has(window.id))
          throw new Error("Ambiguous native window inventory");
        windowIds.add(window.id);
      }
    }
    return apps;
  }

  async inventory(guard: () => Promise<void>) {
    const apps = await this.apps(guard);
    return {
      // Native inventory is limited by the owner's app grants; it never proves all OS windows.
      complete: false,
      apps: apps.map((app) => ({ appId: app.id, name: app.displayName ?? app.id })),
      windows: apps.flatMap((app) =>
        app.windows.map((window) => ({
          appId: window.app,
          windowId: String(window.id),
          title: window.title ?? "",
        })),
      ),
    };
  }

  async capture(
    target: ComputerTarget,
    mode: "normal" | "classic_read_only",
    guard: () => Promise<void>,
  ): Promise<ComputerObservation> {
    // Even a failed replacement capture invalidates the former action reference.
    this.latest = undefined;
    const apps = await this.apps(guard);
    const window = apps
      .flatMap((app) => app.windows)
      .find((candidate) => candidate.app === target.appId && String(candidate.id) === target.windowId);
    if (window === undefined) throw new Error("Target is absent from the current native window inventory");
    assertAllowedTarget(window);
    const { state, shot, png, width, height } = await this.observe(window, guard);
    const bounds = { x: shot.originX, y: shot.originY, width: shot.width, height: shot.height };
    const reference: NativeReference = {
      window: state.window,
      screenshotId: shot.id,
      accessibility: state.accessibility,
      bounds,
      width,
      height,
      sha256: createHash("sha256").update(png).digest("hex"),
    };
    const inputReady = mode === "normal" && this.inputReady && state.accessibility != null;
    if (inputReady) this.latest = reference;
    return {
      target: { appId: state.window.app, windowId: String(state.window.id) },
      png,
      // Native logical screen bounds may differ from delivered PNG dimensions.
      coordinates: { space: "global_display_points", origin: "top_left", bounds },
      inputReady,
      elements: [], // Native UIA indexes are not guessed from formatted tree text.
      ...(state.accessibility == null ? {} : { accessibility: state.accessibility }),
      reference,
    };
  }

  private async observe(window: NativeWindow, guard: () => Promise<void>) {
    await guard();
    // Validate but retain the actual returned native window object, not a clone.
    const raw = await this.native(() =>
      this.client.get_window_state({
        window,
        include_screenshot: true,
        include_text: this.inputReady,
      }),
    );
    const parsed = State.parse(raw);
    const state = { ...parsed, window: (raw as z.infer<typeof State>).window };
    await guard();
    if (state.window.app !== window.app || state.window.id !== window.id)
      throw new Error("Native capture changed its exact window binding");
    assertAllowedTarget(state.window);
    const shot = state.screenshots[0]!;
    if (this.snapshots.has(shot.id)) throw new Error("Native screenshot reference was reused");
    const prefix = "data:image/png;base64,";
    if (!shot.url.startsWith(prefix)) throw new Error("Native capture did not return a PNG");
    const encoded = shot.url.slice(prefix.length);
    const png = Buffer.from(encoded, "base64");
    if (
      png.length < 24 ||
      png.length > COMPUTER_FRAME_MAX_BYTES ||
      png.toString("base64") !== encoded ||
      !png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
      png.toString("ascii", 12, 16) !== "IHDR"
    )
      throw new Error("Invalid native PNG bytes");
    const width = png.readUInt32BE(16),
      height = png.readUInt32BE(20);
    if (width < 1 || width > 16384 || height < 1 || height > 16384)
      throw new Error("Native PNG dimensions are unavailable");
    this.snapshots.add(shot.id);
    if (this.snapshots.size > 1024) this.snapshots.delete(this.snapshots.values().next().value!);
    return { state, shot, png, width, height };
  }

  async input(
    input: ComputerInput,
    observation: ComputerObservation,
    screenshot: ComputerScreenshot,
    guard: () => Promise<void>,
  ) {
    let dispatched = false;
    try {
      this.ensureOpen();
      await guard();
      const client = this.client;
      if (!this.allowInput) throw new Error("Windows input requires explicit owner allowInput opt-in");
      if (!actionClient(client))
        return {
          outcome: "failed" as const,
          detail: "Windows input is not enabled; this adapter only observes",
        };
      const ref = this.latest;
      if (ref === undefined || ref !== observation.reference || !observation.inputReady)
        throw new Error("Windows input requires a fresh, unused native observation");
      if (!input.foreground) throw new Error("Windows input requires explicit foreground authorization");
      assertAllowedTarget(ref.window);
      await this.personQuiet();
      const expected = input.expect;
      if (expected === undefined)
        throw new Error("Windows input requires a specific observable postcondition");
      if (ref.accessibility == null || typeof ref.accessibility[expected.field] !== "string")
        throw new Error("The expected accessibility field is absent from this observation");
      if (ref.accessibility[expected.field] === expected.equals)
        throw new Error("The expected effect is already present before input");
      const bounds = screenshot.coordinates.bounds;
      if (
        screenshot.target.appId !== ref.window.app ||
        screenshot.target.windowId !== String(ref.window.id) ||
        screenshot.width !== ref.width ||
        screenshot.height !== ref.height ||
        screenshot.sha256 !== ref.sha256 ||
        bounds.x !== ref.bounds.x ||
        bounds.y !== ref.bounds.y ||
        bounds.width !== ref.bounds.width ||
        bounds.height !== ref.bounds.height
      )
        throw new Error("Windows screenshot metadata changed its native binding");
      const point = (pixel: { x: number; y: number }) => {
        const mapped = computerPoint(screenshot, pixel);
        return { x: mapped.x - ref.bounds.x, y: mapped.y - ref.bounds.y };
      };
      let primitive: () => Promise<void>;
      switch (input.kind) {
        case "click": {
          const at = point(input.at);
          primitive = () =>
            client.click({
              window: ref.window,
              screenshotId: ref.screenshotId,
              ...at,
              mouse_button: input.button,
            });
          break;
        }
        case "key":
          if (!allowedKeys(input.keys)) throw new Error("Unsupported Windows key chord");
          primitive = () => client.press_key({ window: ref.window, key: input.keys });
          break;
        case "type":
          if (input.clear)
            throw new Error("Windows clear-and-type is compound input; observe each primitive");
          if (
            [...input.text].some(
              (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
            )
          )
            throw new Error("Windows text input requires literal text; use observed key input for controls");
          if (!ref.accessibility.focused_element?.trim())
            throw new Error("Windows typing requires an observed focused element");
          primitive = () => client.type_text({ window: ref.window, text: input.text });
          break;
        case "scroll": {
          if (input.at === undefined) throw new Error("Windows scroll requires a point from this screenshot");
          const at = point(input.at);
          const delta = input.amount;
          primitive = () =>
            client.scroll({
              window: ref.window,
              screenshotId: ref.screenshotId,
              ...at,
              scrollX: input.direction === "right" ? delta : input.direction === "left" ? -delta : 0,
              scrollY: input.direction === "down" ? delta : input.direction === "up" ? -delta : 0,
            });
          break;
        }
        case "drag": {
          const from = point(input.from),
            to = point(input.to);
          primitive = () =>
            client.drag({
              window: ref.window,
              screenshotId: ref.screenshotId,
              from_x: from.x,
              from_y: from.y,
              to_x: to.x,
              to_y: to.y,
            });
          break;
        }
        case "element":
          throw new Error("Windows element input awaits a proven native UIA index contract");
      }
      if (input.kind === "type") {
        // Typing addresses the current focus, not a screenshot coordinate. Recheck
        // that exact focus and effect source immediately before dispatch without
        // changing focus. A person/app edit cannot become evidence of our input.
        await guard();
        const focus = z
          .object({ window: Window, accessibility: Accessibility.nullable() })
          .parse(
            await this.native(() =>
              client.get_window_state({ window: ref.window, include_screenshot: false, include_text: true }),
            ),
          );
        if (
          focus.window.app !== ref.window.app ||
          focus.window.id !== ref.window.id ||
          focus.accessibility?.focused_element !== ref.accessibility.focused_element
        )
          throw new Error("Windows typing focus changed since this observation");
        if (focus.accessibility?.[expected.field] !== ref.accessibility[expected.field])
          throw new Error("Windows typing effect source changed since this observation");
      }
      const current = (await this.apps(guard))
        .flatMap((app) => app.windows)
        .find((window) => window.app === ref.window.app && window.id === ref.window.id);
      if (current === undefined) throw new Error("Windows target disappeared before input");
      assertAllowedTarget(current);
      assertAllowedTarget(ref.window);
      await guard();
      await this.personQuiet();
      // The OS query can wait for a helper process. Recheck owner authority and
      // lease revocation after that wait, before admitting any native effect.
      await guard();
      this.ensureOpen();
      if (Date.parse(screenshot.expiresAt) <= Date.now())
        throw new Error("Windows screenshot expired before dispatch");
      // Consume before native dispatch, including a rejected or lost RPC. The
      // caller must inspect/reconcile this request, never resend its input.
      this.latest = undefined;
      dispatched = true;
      await this.native(primitive);
      try {
        await this.person!.recordDispatchFinished();
      } catch {
        this.fenced = true;
        throw new Error("Windows last-input state unavailable after dispatch; this host is fenced");
      }
      const after = await this.observe(ref.window, guard);
      const shot = after.shot;
      if (
        after.width !== ref.width ||
        after.height !== ref.height ||
        shot.originX !== ref.bounds.x ||
        shot.originY !== ref.bounds.y ||
        shot.width !== ref.bounds.width ||
        shot.height !== ref.bounds.height
      )
        throw new Error("Windows post-action observation changed its exact bounds");
      if (after.state.accessibility?.[expected.field] !== expected.equals)
        throw new Error("Windows post-action observation did not prove the expected effect");
      return {
        outcome: "confirmed" as const,
        detail: `Fresh native observation proved the changed ${expected.field}`,
      };
    } catch (error) {
      return {
        outcome: dispatched ? ("uncertain" as const) : ("failed" as const),
        detail:
          error instanceof z.ZodError
            ? "Windows native observation failed validation"
            : (error instanceof Error ? error.message : "Windows input proof failed").slice(0, 4096),
      };
    }
  }

  private async personQuiet(): Promise<void> {
    try {
      await this.person!.assertQuiet();
    } catch {
      this.fenced = true;
      this.latest = undefined;
      throw new Error("Windows person activity or last-input state prevents input; this host is fenced");
    }
  }

  async stop(guard: () => Promise<void>): Promise<boolean> {
    await guard();
    // A native Promise<void> or an ended REPL is not a host quiescence receipt.
    return false;
  }
}
