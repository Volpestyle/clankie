import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  ComputerCoordinatesSchema,
  computerPoint,
  type ComputerInput,
  type ComputerScreenshot,
  type ComputerTarget,
} from "@clankie/interactive-environment";
import type { ComputerAdapter, ComputerObservation } from "./computer-body.ts";

const execute = promisify(execFile);
const Envelope = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  outcome: z
    .object({
      state: z.string(),
      dispatch_state: z.string().optional(),
      retry_safety: z.string().optional(),
    })
    .optional(),
});
const scalar = z.number().finite();
const nativeRect = z
  .tuple([z.tuple([scalar, scalar]), z.tuple([scalar.positive(), scalar.positive()])])
  .transform(([[x, y], [width, height]]) => ({ x, y, width, height }));
const nativeSize = z
  .tuple([scalar.int().positive(), scalar.int().positive()])
  .transform(([width, height]) => ({ width, height }));
const See = z.object({
  snapshot_id: z.string().nullable().optional(),
  snapshot_reusable: z.boolean(),
  mutation_targeting_available: z.boolean(),
  coordinate_context: z.object({
    version: z.literal(1),
    reference_id: z.string().nullable().optional(),
    logical_space: z.literal("global_display_points"),
    origin: z.literal("top_left"),
    logical_bounds: z.union([nativeRect, ComputerCoordinatesSchema.shape.bounds]),
    delivered_image_size: z.union([
      nativeSize,
      z.object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      }),
    ]),
    window: z.object({ window_id: z.number().int() }).nullable().optional(),
  }),
  ui_elements: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().nullable().optional(),
        title: z.string().nullable().optional(),
        is_actionable: z.boolean(),
      }),
    )
    .max(1600),
});

/** Existing Peekaboo CLI/Bridge path, with no focus, permission or transport fallback. */
export class PeekabooComputerAdapter implements ComputerAdapter {
  readonly bodyId = "macos:console";
  private readonly options: { executable?: string; bridgeSocket?: string };
  constructor(options: { executable?: string; bridgeSocket?: string } = {}) {
    this.options = options;
  }

  private async call(args: string[], guard: () => Promise<void>): Promise<z.infer<typeof Envelope>> {
    await guard();
    const flags =
      this.options.bridgeSocket === undefined ? [] : ["--bridge-socket", this.options.bridgeSocket];
    try {
      const result = await execute(this.options.executable ?? "peekaboo", [...args, ...flags, "--json"], {
        timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return Envelope.parse(JSON.parse(result.stdout));
    } catch (error) {
      // Native refusals can have a nonzero exit code. A timeout/partial JSON remains uncertain.
      const stdout =
        typeof error === "object" && error !== null && "stdout" in error ? error.stdout : undefined;
      if (typeof stdout === "string" && stdout.trim()) return Envelope.parse(JSON.parse(stdout));
      throw error;
    }
  }

  async inventory(guard: () => Promise<void>) {
    const result = await this.call(["app", "list"], guard);
    if (!result.success) throw new Error("Peekaboo app inventory refused");
    const data = z
      .object({
        warnings: z.array(z.unknown()).optional(),
        apps: z.array(z.object({ pid: z.number().int().positive(), name: z.string() })).max(512),
      })
      .parse(result.data);
    let complete = data.warnings?.length === 0;
    const apps = data.apps.map((a) => ({ appId: `PID:${a.pid}`, name: a.name }));
    const windows: { appId: string; windowId: string; title: string }[] = [];
    for (const app of apps) {
      const response = await this.call(["window", "list", "--app", app.appId], guard);
      if (!response.success) {
        complete = false;
        continue;
      } // Apps without an observable window remain in the app inventory.
      const inventory = z
        .object({
          inventory_completeness: z.string().optional(),
          windows: z.array(z.object({ window_id: z.number().int(), window_title: z.string() })).max(2048),
        })
        .parse(response.data);
      if (inventory.inventory_completeness !== "complete") complete = false;
      windows.push(
        ...inventory.windows.map((w) => ({
          appId: app.appId,
          windowId: String(w.window_id),
          title: w.window_title,
        })),
      );
    }
    return { apps, windows, complete };
  }

  async capture(
    target: ComputerTarget,
    mode: "normal" | "classic_read_only",
    guard: () => Promise<void>,
  ): Promise<ComputerObservation> {
    this.target(target);
    const directory = await mkdtemp(join(tmpdir(), "clankie-computer-"));
    try {
      const path = join(directory, "frame.png");
      const readonlyFlags =
        mode === "classic_read_only" ? ["--no-elements", "--no-remote", "--capture-engine", "classic"] : [];
      const result = await this.call(
        ["see", "--app", target.appId, "--window-id", target.windowId, "--path", path, ...readonlyFlags],
        guard,
      );
      if (!result.success) throw new Error("Peekaboo capture refused");
      const data = See.parse(result.data);
      const context = data.coordinate_context;
      const png = await readFile(path); // Never read a path supplied by the producer's JSON.
      if (
        png.length < 24 ||
        png.readUInt32BE(16) !== context.delivered_image_size.width ||
        png.readUInt32BE(20) !== context.delivered_image_size.height ||
        context.window?.window_id !== Number(target.windowId)
      )
        throw new Error("Peekaboo capture dimensions or exact window receipt disagree");
      const reference = data.snapshot_id;
      const inputReady =
        mode === "normal" &&
        data.snapshot_reusable &&
        data.mutation_targeting_available &&
        typeof reference === "string" &&
        reference.startsWith("ps1_") &&
        context.reference_id === reference;
      return {
        target,
        png,
        coordinates: { space: context.logical_space, origin: context.origin, bounds: context.logical_bounds },
        inputReady,
        elements: data.ui_elements.map((e) => ({
          id: e.id,
          label: e.label ?? e.title ?? "",
          actionable: e.is_actionable,
        })),
        reference,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async input(
    input: ComputerInput,
    observation: ComputerObservation,
    screenshot: ComputerScreenshot,
    guard: () => Promise<void>,
  ) {
    this.target(observation.target);
    const reference = observation.reference;
    if (!observation.inputReady || typeof reference !== "string" || !reference.startsWith("ps1_"))
      return { outcome: "failed" as const, detail: "Peekaboo capture is read-only" };
    const args: string[] = [];
    const point = (p: { x: number; y: number }) => {
      const mapped = computerPoint(screenshot, p);
      return `${mapped.x},${mapped.y}`;
    };
    switch (input.kind) {
      case "click":
        args.push("click", "--at", point(input.at), "--global");
        if (input.button === "right") args.push("--right");
        break;
      case "element":
        if (!observation.elements.some((e) => e.id === input.elementId && e.actionable))
          return { outcome: "failed" as const, detail: "Element absent or not actionable in this capture" };
        args.push("click", "--on", input.elementId);
        break;
      case "type":
        args.push("type", "--text", input.text.replaceAll("\\", "\\\\"));
        if (input.clear) args.push("--clear");
        break;
      case "key":
        if (!/^[A-Za-z0-9][A-Za-z0-9+_, -]*$/.test(input.keys))
          return { outcome: "failed" as const, detail: "Invalid key chord" };
        args.push("press", input.keys);
        break;
      case "scroll":
        args.push("scroll", "--direction", input.direction, "--amount", String(input.amount));
        break;
      case "drag":
        if (!input.foreground)
          return { outcome: "failed" as const, detail: "Peekaboo drag requires explicit foreground input" };
        args.push("drag", "--from", point(input.from), "--to", point(input.to));
        break;
    }
    args.push(
      "--app",
      observation.target.appId,
      "--window-id",
      observation.target.windowId,
      "--snapshot",
      reference,
    );
    if (input.foreground) args.push("--foreground");
    const result = await this.call(args, guard);
    const native = result.outcome;
    if (native?.state === "confirmed_change" || native?.state === "confirmed_no_change")
      return { outcome: "confirmed" as const, detail: native.state };
    if (native?.state === "refused" && native.dispatch_state === "none" && native.retry_safety === "safe")
      return { outcome: "failed" as const, detail: "Peekaboo refused before dispatch" };
    return {
      outcome: "uncertain" as const,
      detail: native?.state ?? "Peekaboo returned no canonical action outcome",
    };
  }

  private target(target: ComputerTarget): void {
    if (!/^PID:[1-9][0-9]*$/.test(target.appId) || !/^[0-9]+$/.test(target.windowId))
      throw new Error("Use the exact PID/window IDs from inventory");
  }
  async stop(guard: () => Promise<void>): Promise<boolean> {
    await guard();
    // The existing shared Bridge has no drain/quiescence receipt. Killing our CLI is not proof.
    return false;
  }
}
