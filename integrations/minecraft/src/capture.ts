import { createHash } from "node:crypto";
import {
  RENDERED_SURFACE_FRAME_MAX_BYTES,
  RenderedSurfaceFrameSchema,
  type RenderedSurfaceFrame,
} from "@clankie/interactive-environment";
import type { MinecraftSessionRef, MinecraftStatus } from "@clankie/protocol";
import { createBrokeredActivityFrameSink, type ActivityFrameSink } from "@clankie/rendered-surface-client";
import { sameMinecraftSession, type MinecraftViewerStatus } from "./port.ts";

interface MinecraftCaptureOptions {
  source: {
    status(): Promise<MinecraftStatus>;
    viewerStatus(
      session: MinecraftSessionRef,
    ): Promise<Pick<MinecraftViewerStatus, "session" | "available" | "frameUrl">>;
  };
  producerUrl?: string;
  createSink?: () => Promise<ActivityFrameSink | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
  intervalMs?: number;
  onFrame?: (frame: RenderedSurfaceFrame) => void;
  onError?: (error: unknown) => void;
}

/** One bounded request at a time; a changed/ended session invalidates pending frames. */
export class MinecraftCapture {
  private readonly options: MinecraftCaptureOptions;
  private session: MinecraftSessionRef | undefined;
  private sink: ActivityFrameSink | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private closed = false;
  private sequence = 0;
  private generation = 0;

  public constructor(options: MinecraftCaptureOptions) {
    this.options = options;
  }

  public start(): void {
    if (this.closed || this.timer !== undefined) return;
    const run = async () => {
      this.timer = undefined;
      await this.tick().catch((error: unknown) => this.options.onError?.(error));
      if (!this.closed) {
        this.timer = setTimeout(run, this.options.intervalMs ?? 500);
        this.timer.unref();
      }
    };
    this.timer = setTimeout(run, 0);
    this.timer.unref();
  }

  /** Public for the manual local smoke and deterministic lifecycle checks. */
  public async tick(): Promise<void> {
    if (this.closed || this.inFlight) return;
    this.inFlight = true;
    const generation = this.generation;
    try {
      const status = await this.options.source.status();
      if (this.closed || generation !== this.generation) return;
      const current = status.session;
      if (
        current === null ||
        !["active", "paused", "pausing"].includes(current.phase) ||
        current.termination.state !== "not_requested"
      ) {
        this.invalidate();
        return;
      }
      if (this.session === undefined || !sameMinecraftSession(this.session, current.session)) {
        this.invalidate();
        this.session = current.session;
      }
      if (this.sink === undefined) {
        const selectedSession = this.session;
        const sink = await (
          this.options.createSink ??
          (() =>
            createBrokeredActivityFrameSink({
              url: this.options.producerUrl ?? "ws://127.0.0.1:4322/producer",
            }))
        )();
        if (this.closed || this.session !== selectedSession) {
          sink?.close();
          return;
        }
        this.sink = sink;
      }
      const epoch = this.generation;
      const viewer = await this.options.source.viewerStatus(current.session);
      if (!viewer.available || viewer.frameUrl === undefined) {
        this.invalidate();
        return;
      }
      if (!sameMinecraftSession(viewer.session, current.session)) throw new Error("minecraft_frame_session");
      const frame = await readMinecraftFrame({
        url: viewer.frameUrl,
        session: current.session,
        sequence: this.sequence + 1,
        fetch: this.options.fetch ?? fetch,
        now: this.options.now ?? Date.now,
      });
      const latest = await this.options.source.status();
      if (
        this.closed ||
        epoch !== this.generation ||
        latest.session === null ||
        !sameMinecraftSession(latest.session.session, current.session) ||
        latest.session.termination.state !== "not_requested" ||
        !["active", "paused", "pausing"].includes(latest.session.phase)
      ) {
        this.invalidate();
        return;
      }
      this.sequence = frame.sequence;
      this.sink?.publishFrame(frame);
      this.options.onFrame?.(frame);
    } catch (error) {
      this.invalidate();
      throw error;
    } finally {
      this.inFlight = false;
    }
  }

  public invalidate(): void {
    this.generation += 1;
    this.sink?.close();
    this.sink = undefined;
    this.session = undefined;
    // Sequence stays monotonic for the Activity's connected viewer.
  }

  public close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.invalidate();
  }
}

async function readMinecraftFrame(input: {
  url: string;
  session: MinecraftSessionRef;
  sequence: number;
  fetch: typeof fetch;
  now: () => number;
}): Promise<RenderedSurfaceFrame> {
  const url = new URL(input.url);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username !== "" ||
    url.password !== ""
  )
    throw new Error("minecraft_frame_not_loopback");
  const response = await input.fetch(url, { redirect: "error", signal: AbortSignal.timeout(3_000) });
  if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "image/png") {
    throw new Error("minecraft_frame_unavailable");
  }
  if (
    response.headers.get("x-minecraft-session-id") !== input.session.sessionId ||
    Number(response.headers.get("x-minecraft-connection-generation")) !== input.session.connectionGeneration
  )
    throw new Error("minecraft_frame_session");
  const capturedAt = Number(response.headers.get("x-frame-captured-at"));
  if (
    !Number.isFinite(capturedAt) ||
    capturedAt <= 0 ||
    input.now() - capturedAt > 10_000 ||
    capturedAt > input.now() + 1_000
  ) {
    throw new Error("minecraft_frame_stale");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("minecraft_frame_empty");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > RENDERED_SURFACE_FRAME_MAX_BYTES) throw new Error("minecraft_frame_too_large");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = Buffer.concat(chunks);
  if (
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.subarray(12, 16).toString() !== "IHDR"
  )
    throw new Error("minecraft_frame_invalid_png");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (
    width !== Number(response.headers.get("x-frame-width")) ||
    height !== Number(response.headers.get("x-frame-height"))
  ) {
    throw new Error("minecraft_frame_dimensions");
  }
  return RenderedSurfaceFrameSchema.parse({
    schemaVersion: 1,
    surface: "minecraft",
    sequence: input.sequence,
    frame: input.sequence,
    width,
    height,
    encoding: "png",
    data: bytes.toString("base64"),
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    capturedAt: new Date(capturedAt).toISOString(),
  });
}
