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
import { loadConfig, resolveRole, type MediaModelRole } from "@clankie/model-provider";
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
  generateVideo(request: GenerateVideoRequest, signal?: AbortSignal): Promise<GenerateVideoResult>;
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
}

/** Catalog provider id → the connector's provider enum. */
const PROVIDERS: Readonly<Record<string, MediaProvider>> = {
  openai: "openai",
  google: "google",
  xai: "grok",
};

const DEFAULT_VIDEO_WAIT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;

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
}

export class ConfiguredMediaGenerator implements MediaGeneratorPort {
  private readonly options: ConfiguredMediaGeneratorOptions;
  private readonly videoWaitMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Live renders, so a resumed call knows which request it is picking up. */
  private readonly videoJobs = new Map<string, VideoGenerationRequest>();

  public constructor(options: ConfiguredMediaGeneratorOptions) {
    this.options = options;
    this.videoWaitMs = options.videoWaitMs ?? DEFAULT_VIDEO_WAIT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.now = options.now ?? (() => Date.now());
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
    signal?: AbortSignal,
  ): Promise<GenerateVideoResult> {
    try {
      const model = await this.resolveModel("video_model", "video");
      if (model.provider !== "grok") {
        throw new MediaRefusal("provider_unsupported", `${model.providerId} has no video adapter`);
      }
      const adapter = new GrokVideoAdapter({
        apiKey: model.apiKey,
        ...(this.options.fetchImpl === undefined ? {} : { fetch: this.options.fetchImpl }),
      });
      const generation = await this.videoGenerationRequest(request, model);
      let job: VideoJob = request.requestId
        ? await adapter.poll(request.requestId)
        : await adapter.start(generation);
      this.videoJobs.set(job.requestId, generation);

      // A caller that hung up stops the polling but never the render: the job
      // keeps going upstream and the next call resumes it by id, so abandoning
      // the wait costs nothing but the wait.
      const deadline = this.now() + this.videoWaitMs;
      const startedAt = this.now();
      while (job.status === "pending" && this.now() < deadline && signal?.aborted !== true) {
        await this.sleep(this.pollIntervalMs);
        job = await adapter.poll(job.requestId);
      }
      if (job.status === "failed" || job.status === "expired") {
        this.videoJobs.delete(job.requestId);
        throw new MediaRefusal("provider_failed", job.error ?? job.status);
      }
      if (job.status !== "done") {
        return GenerateVideoResultSchema.parse({
          outcome: "pending",
          schemaVersion: 1,
          requestId: job.requestId,
          waitedSeconds: Math.round((this.now() - startedAt) / 1_000),
        });
      }
      const result = await adapter.retrieve(job, generation);
      this.videoJobs.delete(job.requestId);
      return GenerateVideoResultSchema.parse({
        outcome: "ok",
        schemaVersion: 1,
        ...this.reference(result.artifactPath, result.sha256),
        mimeType: result.mimeType,
        byteLength: result.bytes,
        provider: model.providerId,
        model: model.modelId,
      });
    } catch (error) {
      return GenerateVideoResultSchema.parse({ outcome: "refused", schemaVersion: 1, ...refusal(error) });
    }
  }

  /**
   * A resumed render must land somewhere, and the original request carries the
   * path. Losing it to a service restart is not a failure worth a durable
   * store: the job is still rendering upstream, and a fresh output path for the
   * same finished bytes is the correct recovery.
   */
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
    const config = {
      apiKey: model.apiKey,
      ...(this.options.fetchImpl === undefined ? {} : { fetch: this.options.fetchImpl }),
    };
    switch (model.provider) {
      case "openai":
        return new OpenAiImageAdapter(config);
      case "google":
        return new GoogleImageAdapter(config);
      case "grok":
        return new GrokImageAdapter(config);
    }
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
    const apiKey = await this.apiKey(resolved.providerId);
    return { providerId: resolved.providerId, provider, modelId: resolved.modelId, apiKey };
  }

  /**
   * The stored credential first, the provider's declared environment variables
   * second — the same two connections `/auth` reports, in the same order, so a
   * provider the TUI calls connected is one this can actually use.
   */
  private async apiKey(providerId: string): Promise<string> {
    const stored = await this.options.credentials.get(providerId);
    if (stored?.type === "api" && stored.key.trim().length > 0) return stored.key;
    const environment = this.options.environment ?? process.env;
    for (const name of loadBundledCatalog()[providerId]?.env ?? []) {
      const value = environment[name]?.trim();
      if (value) return value;
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
