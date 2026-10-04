import { z } from "zod";
import {
  COMPUTER_FRAME_MAX_BYTES,
  type ComputerInput,
  type ComputerScreenshot,
  type ComputerTarget,
} from "@clankie/interactive-environment";
import type { ComputerAdapter, ComputerObservation } from "./computer-body.ts";

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
const State = z.object({
  window: Window,
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
 * No helper executable, private RPC, app launch, foreground activation or input API.
 */
export interface WindowsComputerObservationClient {
  readonly target: "windows";
  list_apps(): Promise<unknown>;
  get_window_state(input: {
    window: NativeWindow;
    include_screenshot: true;
    include_text: false;
  }): Promise<unknown>;
}

/** Read-only Windows adapter. App access and turn-stop checks remain with Codex. */
export class WindowsComputerAdapter implements ComputerAdapter {
  readonly bodyId: string;
  private readonly client: WindowsComputerObservationClient;
  private readonly snapshots = new Set<string>();

  constructor(client: WindowsComputerObservationClient, machineId: string) {
    if (client.target !== "windows" || !/^[a-z][a-z0-9-]{0,63}$/u.test(machineId))
      throw new Error("An identified Windows native computer-use host is required");
    this.bodyId = `windows:${machineId}:console`;
    this.client = client;
  }

  private async apps(guard: () => Promise<void>) {
    await guard();
    const raw = await this.client.list_apps();
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
    _mode: "normal" | "classic_read_only",
    guard: () => Promise<void>,
  ): Promise<ComputerObservation> {
    const apps = await this.apps(guard);
    const window = apps
      .flatMap((app) => app.windows)
      .find((candidate) => candidate.app === target.appId && String(candidate.id) === target.windowId);
    if (window === undefined) throw new Error("Target is absent from the current native window inventory");
    await guard();
    // Pass the actual returned object, never a constructed handle or a title match.
    const state = State.parse(
      await this.client.get_window_state({ window, include_screenshot: true, include_text: false }),
    );
    await guard();
    if (state.window.app !== window.app || state.window.id !== window.id)
      throw new Error("Native capture changed its exact window binding");
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
    return {
      target: { appId: state.window.app, windowId: String(state.window.id) },
      png,
      // Native bounds are logical screen coordinates; delivered PNG pixels may have a different scale.
      coordinates: {
        space: "global_display_points",
        origin: "top_left",
        bounds: { x: shot.originX, y: shot.originY, width: shot.width, height: shot.height },
      },
      inputReady: false,
      elements: [],
      reference: { window: state.window, screenshotId: shot.id },
    };
  }

  async input(
    _input: ComputerInput,
    _observation: ComputerObservation,
    _screenshot: ComputerScreenshot,
    guard: () => Promise<void>,
  ) {
    await guard();
    return { outcome: "failed" as const, detail: "Windows input is not enabled; this adapter only observes" };
  }

  async stop(guard: () => Promise<void>): Promise<boolean> {
    await guard();
    // A native Promise<void> or an ended REPL is not a host quiescence receipt.
    return false;
  }
}
