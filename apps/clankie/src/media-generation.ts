import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialStore } from "@clankie/credential-broker";
import {
  GoogleImageAdapter,
  GrokImageAdapter,
  GrokVideoAdapter,
  MEDIA_GENERATION_SCHEMA_VERSION,
  OpenAiImageAdapter,
  readSourceImageDataUrl,
  type ImageGenerationRequest,
  type MediaFetch,
  type MediaGenerationAdapter,
  type MediaProvider,
  type VideoGenerationRequest,
  type VideoJob,
} from "@clankie/media-connector";
import { loadBundledCatalog } from "@clankie/model-registry";
import {
  createXaiFetch,
  loadConfig,
  OAUTH_PLACEHOLDER_API_KEY,
  resolveRole,
  XAI_PROVIDER_ID,
  type MediaModelRole,
} from "@clankie/model-provider";
import {
  GENERATED_MEDIA_DIRECTORY,
  GenerateImageResultSchema,
  GenerateVideoResultSchema,
  type GenerateImageRequest,
  type GenerateImageResult,
  type GenerateVideoRequest,
  type GenerateVideoResult,
  type MediaRefusalReason,
} from "@clankie/protocol";

/**
 * Where making a picture actually happens (ADR 0085).
 *
 * Provider and model come from operator config (`/image-model`, `/video-model`)
 * and never from the request. A turn chooses what to draw, not what to spend.
 */
export interface MediaGeneratorPort {
  generateImage(request: GenerateImageRequest): Promise<GenerateImageResult>;
  /** `signal` abandons the wait on a hung-up caller; the render itself continues upstream. */
  generateVideo(request: GenerateVideoRequest, options?: GenerateVideoOptions): Promise<GenerateVideoResult>;
  /**
   * Renders this room started that outlived the call and have since landed,
   * and that he has not collected yet (ADR 0094).
   *
   * Checks the outstanding ones as it goes: the turn is the clock, so a render
   * is only ever asked about when someone is there to be told. Scoped by room
   * for the same reason `observe_room` is — what he was asked to make in one
   * channel is not another channel's business.
   */
  finishedRenders(room: string): Promise<readonly FinishedRender[]>;
}

export interface GenerateVideoOptions {
  /** Abandons the wait on a hung-up caller; the render itself continues. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Opaque key for the room that asked, stored and compared verbatim — the
   * generator never parses it. Absent means nobody is told when it lands.
   */
  readonly room?: string | undefined;
}

/** A render that outlived its call, waiting to be collected. */
export interface FinishedRender {
  readonly requestId: string;
  /** What he asked for, so the reminder names the right video. */
  readonly prompt: string;
  readonly outcome: "ok" | "refused";
  /** Seconds between starting the render and it landing. */
  readonly tookSeconds: number;
}

export interface ConfiguredMediaGeneratorOptions {
  readonly credentials: CredentialStore;
  /** Root the Discord attachment resolver serves; media lands in its `generated/` subdirectory. */
  readonly attachmentRoot: string;
  /** Where `loadConfig` looks for `clankie.json`; the repo root in practice. */
  readonly configCwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  /** Injectable provider transport. Production leaves it unset and the adapters use `fetch`. */
  readonly fetchImpl?: MediaFetch;
  /** How long a video render may hold the call before it comes back as `pending`. */
  readonly videoWaitMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** How long a render may keep going after its call gave up waiting. */
  readonly backgroundRenderMs?: number;
  /** How long a finished, uncollected render keeps reminding him it exists. */
  readonly renderRetentionMs?: number;
}

/** Catalog provider id → the connector's provider enum. */
const PROVIDERS: Readonly<Record<string, MediaProvider>> = {
  openai: "openai",
  google: "google",
  xai: "grok",
};

const DEFAULT_VIDEO_WAIT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
/**
 * How long a render keeps going once nobody is waiting on the call.
 *
 * Generous, because the whole point is that a slow render still lands: the
 * failure this replaces is a render that finished upstream while the only
 * thing that knew its id — a one-shot Discord session — had already been
 * disposed.
 */
const DEFAULT_BACKGROUND_RENDER_MS = 1_800_000;
/**
 * How long a finished, uncollected render stays worth mentioning. Past this he
 * stops being told about it: a video nobody came back for in an hour is a video
 * the conversation has moved on from.
 */
const DEFAULT_RENDER_RETENTION_MS = 3_600_000;

/** Extension by provider default, so the adapter's format negotiation and the filename agree. */
const IMAGE_EXTENSION = "png";
const VIDEO_EXTENSION = "mp4";

class MediaRefusal extends Error {
  public readonly reason: MediaRefusalReason;
  public readonly detail: string | undefined;

  public constructor(reason: MediaRefusalReason, detail?: string) {
    super(reason);
    this.reason = reason;
    this.detail = detail?.slice(0, 500);
  }
}

interface ResolvedMediaModel {
  readonly providerId: string;
  readonly provider: MediaProvider;
  readonly modelId: string;
  readonly apiKey: string;
  readonly fetch?: MediaFetch;
}

/** One video render, tracked past the call that started it. */
interface RenderRecord {
  readonly requestId: string;
  readonly prompt: string;
  readonly room: string | undefined;
  readonly startedAt: number;
  status: "rendering" | "finished";
  /** The answer to give when he comes back for it: the `ok` or the `refused`. */
  result: GenerateVideoResult | undefined;
  finishedAt: number | undefined;
  /** Set once he has been handed the result, so it stops being mentioned. */
  collected: boolean;
}

export class ConfiguredMediaGenerator implements MediaGeneratorPort {
  private readonly options: ConfiguredMediaGeneratorOptions;
  private readonly videoWaitMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly backgroundRenderMs: number;
  private readonly renderRetentionMs: number;
  /** Live renders, so a resumed call knows which request it is picking up. */
  private readonly videoJobs = new Map<string, VideoGenerationRequest>();
  /** Every render this process started, until it is collected or ages out. */
  private readonly renders = new Map<string, RenderRecord>();

  public constructor(options: ConfiguredMediaGeneratorOptions) {
    this.options = options;
    this.videoWaitMs = options.videoWaitMs ?? DEFAULT_VIDEO_WAIT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.now = options.now ?? (() => Date.now());
    this.backgroundRenderMs = options.backgroundRenderMs ?? DEFAULT_BACKGROUND_RENDER_MS;
    this.renderRetentionMs = options.renderRetentionMs ?? DEFAULT_RENDER_RETENTION_MS;
  }

  public async finishedRenders(room: string): Promise<readonly FinishedRender[]> {
    // Deleting during iteration is safe here: entries are only ever removed,
    // never added, so a dropped record is simply one this pass skips.
    for (const record of this.renders.values()) {
      if (record.room !== room) continue;
      this.forgetIfStale(record);
      if (record.status === "rendering") await this.checkRender(record);
    }
    const now = this.now();
    const ready: FinishedRender[] = [];
    for (const record of this.renders.values()) {
      if (record.room !== room) continue;
      if (record.status !== "finished" || record.collected || record.result === undefined) continue;
      ready.push({
        requestId: record.requestId,
        prompt: record.prompt,
        outcome: record.result.outcome === "ok" ? "ok" : "refused",
        tookSeconds: Math.round(((record.finishedAt ?? now) - record.startedAt) / 1_000),
      });
    }
    return ready;
  }

  /**
   * Ask the provider once whether an outstanding render has landed, and finish
   * it if it has.
   *
   * One call per outstanding render per turn at most, and only for the room
   * being asked about. A render that has outrun its window stops being checked
   * — the requestId still works, so a job that is somehow still going remains
   * reachable by asking for it directly.
   */
  private async checkRender(record: RenderRecord): Promise<void> {
    if (this.now() - record.startedAt > this.backgroundRenderMs) {
      this.renders.delete(record.requestId);
      return;
    }
    const generation = this.videoJobs.get(record.requestId);
    if (generation === undefined) return;
    try {
      const model = await this.resolveModel("video_model", "video");
      if (model.provider !== "grok") return;
      const adapter = new GrokVideoAdapter(this.adapterConfig(model));
      const job = await adapter.poll(record.requestId);
      if (job.status === "pending") return;
      if (job.status !== "done") throw new MediaRefusal("provider_failed", job.error ?? job.status);
      this.settleRender(record, await this.retrieveRender(adapter, job, generation, model), false);
    } catch (error) {
      this.settleRender(
        record,
        GenerateVideoResultSchema.parse({ outcome: "refused", schemaVersion: 1, ...refusal(error) }),
        false,
      );
    }
  }

  /** A landed render nobody came back for eventually stops being mentioned. */
  private forgetIfStale(record: RenderRecord): void {
    if (record.finishedAt === undefined) return;
    if (this.now() - record.finishedAt > this.renderRetentionMs) this.renders.delete(record.requestId);
  }

  public async generateImage(request: GenerateImageRequest): Promise<GenerateImageResult> {
    try {
      const model = await this.resolveModel("image_model", "image");
      const outputPath = await this.artifactPath(IMAGE_EXTENSION);
      const sourceImage =
        request.sourceRef === undefined
          ? undefined
          : await readSourceImageDataUrl(this.pathForRef(request.sourceRef));
      const generation: ImageGenerationRequest = {
        schemaVersion: MEDIA_GENERATION_SCHEMA_VERSION,
        kind: "image",
        prompt: request.prompt,
        provider: model.provider,
        model: model.modelId,
        outputPath,
        ...(request.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio }),
        ...(sourceImage === undefined ? {} : { sourceImage }),
      };
      const result = await this.imageAdapter(model).generate(generation);
      return GenerateImageResultSchema.parse({
        outcome: "ok",
        schemaVersion: 1,
        ...this.reference(result.artifactPath, result.sha256),
        mimeType: result.mimeType,
        byteLength: result.bytes,
        provider: model.providerId,
        model: model.modelId,
      });
    } catch (error) {
      return GenerateImageResultSchema.parse({ outcome: "refused", schemaVersion: 1, ...refusal(error) });
    }
  }

  public async generateVideo(
    request: GenerateVideoRequest,
    options?: GenerateVideoOptions,
  ): Promise<GenerateVideoResult> {
    // A render the background finished already: hand back the answer it landed
    // on rather than paying the provider to retrieve the same bytes twice.
    const collected = request.requestId === undefined ? undefined : this.renders.get(request.requestId);
    if (collected?.status === "finished" && collected.result !== undefined) {
      collected.collected = true;
      return collected.result;
    }
    try {
      const model = await this.resolveModel("video_model", "video");
      if (model.provider !== "grok") {
        throw new MediaRefusal("provider_unsupported", `${model.providerId} has no video adapter`);
      }
      const adapter = new GrokVideoAdapter(this.adapterConfig(model));
      const generation = await this.videoGenerationRequest(request, model);
      let job: VideoJob = request.requestId
        ? await adapter.poll(request.requestId)
        : await adapter.start(generation);
      this.videoJobs.set(job.requestId, generation);
      const record = this.rememberRender(job.requestId, generation.prompt, options?.room);

      // A caller that hung up stops the polling but never the render: the job
      // keeps going upstream, and either the background finishes it or the next
      // call resumes it by id, so abandoning the wait costs nothing but the wait.
      const deadline = this.now() + this.videoWaitMs;
      const startedAt = this.now();
      while (job.status === "pending" && this.now() < deadline && options?.signal?.aborted !== true) {
        await this.sleep(this.pollIntervalMs);
        job = await adapter.poll(job.requestId);
      }
      if (job.status === "failed" || job.status === "expired") {
        throw new MediaRefusal("provider_failed", job.error ?? job.status);
      }
      if (job.status !== "done") {
        // The render outlives this call: the record keeps it, and the next turn
        // in this room checks on it (ADR 0094). He is handed the requestId
        // regardless — the record is in memory, so asking by id stays the
        // recovery that survives a restart.
        return GenerateVideoResultSchema.parse({
          outcome: "pending",
          schemaVersion: 1,
          requestId: job.requestId,
          waitedSeconds: Math.round((this.now() - startedAt) / 1_000),
        });
      }
      const settled = await this.retrieveRender(adapter, job, generation, model);
      this.settleRender(record, settled, true);
      return settled;
    } catch (error) {
      const refused = GenerateVideoResultSchema.parse({
        outcome: "refused",
        schemaVersion: 1,
        ...refusal(error),
      });
      // A record only exists once the job was accepted upstream; a failure
      // before that has nothing to settle and nothing to tell the room about.
      const started = request.requestId === undefined ? undefined : this.renders.get(request.requestId);
      if (started !== undefined) this.settleRender(started, refused, true);
      return refused;
    }
  }

  private async retrieveRender(
    adapter: GrokVideoAdapter,
    job: VideoJob,
    generation: VideoGenerationRequest,
    model: ResolvedMediaModel,
  ): Promise<GenerateVideoResult> {
    const result = await adapter.retrieve(job, generation);
    return GenerateVideoResultSchema.parse({
      outcome: "ok",
      schemaVersion: 1,
      ...this.reference(result.artifactPath, result.sha256),
      mimeType: result.mimeType,
      byteLength: result.bytes,
      provider: model.providerId,
      model: model.modelId,
    });
  }

  private rememberRender(requestId: string, prompt: string, room: string | undefined): RenderRecord {
    const existing = this.renders.get(requestId);
    if (existing !== undefined) return existing;
    const record: RenderRecord = {
      requestId,
      prompt,
      room,
      startedAt: this.now(),
      status: "rendering",
      result: undefined,
      finishedAt: undefined,
      collected: false,
    };
    this.renders.set(requestId, record);
    return record;
  }

  /** `collected` is true when a caller is holding the answer as it settles. */
  private settleRender(record: RenderRecord, result: GenerateVideoResult, collected: boolean): void {
    this.videoJobs.delete(record.requestId);
    record.status = "finished";
    record.result = result;
    record.finishedAt = this.now();
    if (collected) record.collected = true;
  }

  private async videoGenerationRequest(
    request: GenerateVideoRequest,
    model: ResolvedMediaModel,
  ): Promise<VideoGenerationRequest> {
    const remembered = request.requestId ? this.videoJobs.get(request.requestId) : undefined;
    if (remembered !== undefined) return remembered;
    return {
      schemaVersion: MEDIA_GENERATION_SCHEMA_VERSION,
      kind: "video",
      prompt: request.prompt ?? "resumed render",
      provider: model.provider,
      model: model.modelId,
      outputPath: await this.artifactPath(VIDEO_EXTENSION),
      ...(request.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio }),
      ...(request.durationSeconds === undefined ? {} : { durationSeconds: request.durationSeconds }),
    };
  }

  private imageAdapter(model: ResolvedMediaModel): MediaGenerationAdapter {
    const config = this.adapterConfig(model);
    switch (model.provider) {
      case "openai":
        return new OpenAiImageAdapter(config);
      case "google":
        return new GoogleImageAdapter(config);
      case "grok":
        return new GrokImageAdapter(config);
    }
  }

  private adapterConfig(model: ResolvedMediaModel): {
    apiKey: string;
    fetch?: MediaFetch;
  } {
    return {
      apiKey: model.apiKey,
      ...(model.fetch === undefined ? {} : { fetch: model.fetch }),
    };
  }

  private async resolveModel(role: MediaModelRole, kind: "image" | "video"): Promise<ResolvedMediaModel> {
    const { config } = await loadConfig({
      cwd: this.options.configCwd,
      ...(this.options.environment === undefined ? {} : { env: this.options.environment }),
    });
    const resolved = resolveRole(role, { config, catalog: loadBundledCatalog() });
    if (resolved === undefined) {
      throw new MediaRefusal("no_model_configured", `set one with /${kind}-model`);
    }
    const provider = PROVIDERS[resolved.providerId];
    if (provider === undefined) {
      throw new MediaRefusal("provider_unsupported", `${resolved.providerId} has no media adapter`);
    }
    return {
      providerId: resolved.providerId,
      provider,
      modelId: resolved.modelId,
      ...(await this.mediaAuth(resolved.providerId)),
    };
  }

  /**
   * The stored credential first, the provider's declared environment variables
   * second — the same two connections `/auth` reports, in the same order, so a
   * provider the TUI calls connected is one this can actually use.
   *
   * SuperGrok OAuth on `xai` outranks a metered `XAI_API_KEY`: the fetch
   * adapter refreshes and injects the live Bearer, so pictures and video ride
   * the subscription the same way captain turns do.
   */
  private async mediaAuth(providerId: string): Promise<{ apiKey: string; fetch?: MediaFetch }> {
    const stored = await this.options.credentials.get(providerId);
    if (providerId === XAI_PROVIDER_ID && stored?.type === "oauth") {
      return {
        apiKey: OAUTH_PLACEHOLDER_API_KEY,
        fetch: createXaiFetch({
          store: this.options.credentials,
          ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
        }),
      };
    }
    if (stored?.type === "api" && stored.key.trim().length > 0) {
      return {
        apiKey: stored.key,
        ...(this.options.fetchImpl === undefined ? {} : { fetch: this.options.fetchImpl }),
      };
    }
    const environment = this.options.environment ?? process.env;
    for (const name of loadBundledCatalog()[providerId]?.env ?? []) {
      const value = environment[name]?.trim();
      if (value) {
        return {
          apiKey: value,
          ...(this.options.fetchImpl === undefined ? {} : { fetch: this.options.fetchImpl }),
        };
      }
    }
    throw new MediaRefusal("credential_unavailable", `store one with /auth for ${providerId}`);
  }

  private async artifactPath(extension: string): Promise<string> {
    const directory = join(this.options.attachmentRoot, GENERATED_MEDIA_DIRECTORY);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return join(directory, `${randomUUID()}.${extension}`);
  }

  private pathForRef(artifactRef: string): string {
    // Shape already validated by `isGeneratedMediaRef`: one safe segment under
    // the generated directory, so this cannot climb out of the root.
    const relativePath = artifactRef.slice(artifactRef.indexOf(":", 7) + 1);
    return join(this.options.attachmentRoot, relativePath);
  }

  private reference(artifactPath: string, sha256: string): { artifactRef: string; filename: string } {
    const filename = artifactPath.slice(artifactPath.lastIndexOf("/") + 1);
    return {
      artifactRef: `sha256:${sha256}:${GENERATED_MEDIA_DIRECTORY}/${filename}`,
      filename,
    };
  }
}

/**
 * Provider errors become refusals rather than 500s. He is going to have to say
 * something to whoever asked, and "the provider rejected it" is sayable where
 * an exception is not.
 */
function refusal(error: unknown): { reason: MediaRefusalReason; detail?: string } {
  if (error instanceof MediaRefusal) {
    return { reason: error.reason, ...(error.detail === undefined ? {} : { detail: error.detail }) };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("artifact_too_large")) return { reason: "artifact_too_large" };
  return { reason: "provider_failed", detail: message.slice(0, 500) };
}
