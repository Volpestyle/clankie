import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { createConnectorActionClassifier, decideAction, type CompiledDoctrine } from "@clankie/doctrine";
import type { ActionRequest } from "@clankie/protocol";
import { z } from "zod";

/**
 * Schema version 2 (ADR 0085) adds `kind: video` and image editing to the
 * boundary ADR 0029 froze at images. The version moved rather than the enum
 * widening in place: video carries request semantics an image request has no
 * field for (duration, resolution) and is an asynchronous job rather than one
 * request/response, and ADR 0029 named exactly that as the condition for an
 * increment.
 */
export const MEDIA_GENERATION_SCHEMA_VERSION = 2;
export const MEDIA_GENERATE_IMAGE_ACTION = "media.generate.image";
export const MEDIA_GENERATE_VIDEO_ACTION = "media.generate.video";

export const MediaKindSchema = z.enum(["image", "video"]);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const MediaProviderSchema = z.enum(["openai", "google", "grok"]);
export type MediaProvider = z.infer<typeof MediaProviderSchema>;

const AspectRatioSchema = z
  .string()
  .trim()
  .regex(/^\d{1,4}(?:\.\d)?:\d{1,4}(?:\.\d)?$/u);

const commonRequestFields = {
  schemaVersion: z.literal(MEDIA_GENERATION_SCHEMA_VERSION),
  prompt: z.string().trim().min(1).max(32_000),
  provider: MediaProviderSchema,
  model: z.string().trim().min(1).max(200),
  outputPath: z.string().trim().min(1),
};

export const ImageGenerationRequestSchema = z
  .object({
    ...commonRequestFields,
    kind: z.literal("image"),
    size: z.string().trim().min(1).max(64).optional(),
    aspectRatio: AspectRatioSchema.optional(),
    /**
     * A data URI or provider-hosted URL to edit rather than generate from
     * scratch. Present means the call routes to the provider's edit endpoint;
     * absent means generation. Callers pass local bytes as a data URI, which
     * keeps this package from ever reading a path it was not handed.
     */
    sourceImage: z.string().trim().min(1).max(20_000_000).optional(),
  })
  .strict();

export const VideoGenerationRequestSchema = z
  .object({
    ...commonRequestFields,
    kind: z.literal("video"),
    aspectRatio: AspectRatioSchema.optional(),
    durationSeconds: z.number().int().min(1).max(15).optional(),
    resolution: z.enum(["480p", "720p", "1080p"]).optional(),
  })
  .strict();

export const MediaGenerationRequestSchema = z.discriminatedUnion("kind", [
  ImageGenerationRequestSchema,
  VideoGenerationRequestSchema,
]);
export type MediaGenerationRequest = z.infer<typeof MediaGenerationRequestSchema>;
export type ImageGenerationRequest = z.infer<typeof ImageGenerationRequestSchema>;
export type VideoGenerationRequest = z.infer<typeof VideoGenerationRequestSchema>;

export const MediaGenerationResultSchema = z
  .object({
    schemaVersion: z.literal(MEDIA_GENERATION_SCHEMA_VERSION),
    kind: MediaKindSchema,
    artifactPath: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    provider: MediaProviderSchema,
    model: z.string().min(1),
    providerRequestId: z.string().min(1).optional(),
    mimeType: z.string().min(1),
    bytes: z.number().int().nonnegative(),
  })
  .strict();
export type MediaGenerationResult = z.infer<typeof MediaGenerationResultSchema>;

export type MediaFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface MediaGenerationAdapter {
  readonly provider: MediaProvider;
  generate(request: ImageGenerationRequest): Promise<MediaGenerationResult>;
}

export interface MediaAdapterConfig {
  apiKey: string;
  fetch?: MediaFetch;
  endpoint?: string;
}

/** Ceiling on any artifact this package writes, generated or downloaded. */
export const MEDIA_ARTIFACT_BYTES_MAX = 25 * 1024 * 1024;

abstract class FetchMediaAdapter implements MediaGenerationAdapter {
  public abstract readonly provider: MediaProvider;
  protected readonly apiKey: string;
  protected readonly transport: MediaFetch;
  protected readonly endpoint: string | undefined;

  public constructor(config: MediaAdapterConfig) {
    if (!config.apiKey.trim()) throw new Error("media_connector_api_key_required");
    this.apiKey = config.apiKey;
    this.transport = config.fetch ?? globalThis.fetch;
    this.endpoint = config.endpoint;
  }

  public async generate(input: ImageGenerationRequest): Promise<MediaGenerationResult> {
    const request = ImageGenerationRequestSchema.parse(input);
    if (request.provider !== this.provider) throw new Error("media_connector_provider_mismatch");
    assertAllowedOutputPath(request.outputPath);
    const generated = await this.fetchImage(request);
    return writeArtifact(request, generated);
  }

  protected abstract fetchImage(request: ImageGenerationRequest): Promise<GeneratedMedia>;

  protected async send(url: string, init: RequestInit): Promise<Response> {
    const response = await this.transport(url, init);
    if (!response.ok) throw new Error(`media_connector_provider_error:${String(response.status)}`);
    return response;
  }
}

interface GeneratedMedia {
  bytes: Uint8Array;
  mimeType: string;
  requestId?: string;
}

async function writeArtifact(
  request: MediaGenerationRequest,
  generated: GeneratedMedia,
): Promise<MediaGenerationResult> {
  if (generated.bytes.byteLength === 0) throw new Error("media_connector_empty_artifact");
  if (generated.bytes.byteLength > MEDIA_ARTIFACT_BYTES_MAX) {
    throw new Error("media_connector_artifact_too_large");
  }
  const artifactPath = resolve(request.outputPath);
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, generated.bytes, { mode: 0o600 });
  return MediaGenerationResultSchema.parse({
    schemaVersion: MEDIA_GENERATION_SCHEMA_VERSION,
    kind: request.kind,
    artifactPath,
    sha256: createHash("sha256").update(generated.bytes).digest("hex"),
    provider: request.provider,
    model: request.model,
    ...(generated.requestId ? { providerRequestId: generated.requestId } : {}),
    mimeType: generated.mimeType,
    bytes: generated.bytes.byteLength,
  });
}

export class OpenAiImageAdapter extends FetchMediaAdapter {
  public readonly provider = "openai" as const;

  protected async fetchImage(request: ImageGenerationRequest): Promise<GeneratedMedia> {
    requireModel(request.model, "gpt-image-2");
    const base = this.endpoint ?? "https://api.openai.com/v1/images";
    // Both endpoints answer with the same body, but they do not take the same
    // request: `/generations` is JSON, and `/edits` is multipart with the source
    // as an uploaded file. xAI's pair differs the other way round (JSON for
    // both, source as a typed object), which is exactly why the wire format
    // lives per adapter rather than in one shared request builder.
    const response =
      request.sourceImage === undefined
        ? await this.send(`${base}/generations`, {
            method: "POST",
            headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({
              model: request.model,
              prompt: request.prompt,
              ...(request.size ? { size: request.size } : {}),
              output_format: outputFormat(request.outputPath),
            }),
          })
        : await this.send(`${base}/edits`, {
            method: "POST",
            // No content-type: `fetch` sets it with the multipart boundary.
            headers: { authorization: `Bearer ${this.apiKey}` },
            body: editForm(request),
          });
    const body = OpenAiResponseSchema.parse(await response.json());
    return {
      bytes: decodeBase64(body.data[0]!.b64_json),
      mimeType: mimeTypeFor(request.outputPath),
      ...providerRequestId(response),
    };
  }
}

/** `image[]` is the array form the edits endpoint expects, even for one source. */
function editForm(request: ImageGenerationRequest): FormData {
  const source = decodeDataUri(request.sourceImage ?? "");
  const form = new FormData();
  form.append("model", request.model);
  form.append("prompt", request.prompt);
  if (request.size) form.append("size", request.size);
  form.append("output_format", outputFormat(request.outputPath));
  const extension = source.mimeType.split("/")[1] ?? "png";
  // Copied into a fresh view: `Blob` wants an `ArrayBuffer`-backed one, and a
  // decoded `Buffer` is typed as possibly `SharedArrayBuffer`-backed.
  const part = new Blob([new Uint8Array(source.bytes)], { type: source.mimeType });
  form.append("image[]", part, `source.${extension}`);
  return form;
}

export class GoogleImageAdapter extends FetchMediaAdapter {
  public readonly provider = "google" as const;

  protected async fetchImage(request: ImageGenerationRequest): Promise<GeneratedMedia> {
    requireModel(request.model, "gemini-3.1-flash-image");
    const base = this.endpoint ?? "https://generativelanguage.googleapis.com/v1beta";
    const url = `${base}/models/${encodeURIComponent(request.model)}:generateContent`;
    const response = await this.send(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: request.prompt },
              ...(request.sourceImage === undefined ? [] : [inlineDataPart(request.sourceImage)]),
            ],
          },
        ],
        generationConfig: {
          responseModalities: ["IMAGE"],
          ...(request.aspectRatio ? { imageConfig: { aspectRatio: request.aspectRatio } } : {}),
        },
      }),
    });
    const body = GoogleResponseSchema.parse(await response.json());
    const image = body.candidates[0]!.content.parts.find((part) => part.inlineData)?.inlineData;
    if (!image) throw new Error("media_connector_provider_response_missing_image");
    return {
      bytes: decodeBase64(image.data),
      mimeType: image.mimeType,
      ...providerRequestId(response),
    };
  }
}

export class GrokImageAdapter extends FetchMediaAdapter {
  public readonly provider = "grok" as const;

  protected async fetchImage(request: ImageGenerationRequest): Promise<GeneratedMedia> {
    requireModel(request.model, "grok-imagine-image-quality");
    const editing = request.sourceImage !== undefined;
    const base = this.endpoint ?? "https://api.x.ai/v1/images";
    const response = await this.send(`${base}/${editing ? "edits" : "generations"}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
        // The edit endpoint takes the source as a typed object rather than a
        // bare string, and rejects multipart entirely — it is JSON only.
        ...(editing ? { image: { type: "image_url", url: request.sourceImage } } : {}),
        response_format: "b64_json",
      }),
    });
    const body = GrokImageResponseSchema.parse(await response.json());
    const datum = body.data[0]!;
    return {
      bytes: decodeBase64(datum.b64_json),
      mimeType: mimeTypeFor(request.outputPath),
      ...providerRequestId(response),
    };
  }
}

// ---------------------------------------------------------------------------
// Video (ADR 0085).
//
// Unlike an image, a video is a job: the provider accepts a prompt, returns a
// request id, and renders for anywhere from seconds to minutes. The three steps
// stay separate primitives rather than one blocking `generate()` because the
// caller — not this package — owns how long a conversation may wait and whether
// an unfinished render is resumed or abandoned. A package that slept on its own
// budget would make that decision for every caller.
// ---------------------------------------------------------------------------

export const VideoJobStatusSchema = z.enum(["pending", "done", "failed", "expired"]);
export type VideoJobStatus = z.infer<typeof VideoJobStatusSchema>;

export interface VideoJob {
  readonly requestId: string;
  readonly status: VideoJobStatus;
  /** Provider-hosted and temporary; present only once the status is `done`. */
  readonly videoUrl?: string;
  readonly error?: string;
}

/** Hosts a rendered video may be downloaded from. A provider response is not a licence to fetch anywhere. */
const GROK_VIDEO_HOSTS = /^(?:[a-z0-9-]+\.)*x\.ai$/u;

export class GrokVideoAdapter {
  public readonly provider = "grok" as const;
  private readonly apiKey: string;
  private readonly transport: MediaFetch;
  private readonly endpoint: string;

  public constructor(config: MediaAdapterConfig) {
    if (!config.apiKey.trim()) throw new Error("media_connector_api_key_required");
    this.apiKey = config.apiKey;
    this.transport = config.fetch ?? globalThis.fetch;
    this.endpoint = config.endpoint ?? "https://api.x.ai/v1/videos";
  }

  /** Submits the render and returns immediately with the job's identity. */
  public async start(input: VideoGenerationRequest): Promise<VideoJob> {
    const request = VideoGenerationRequestSchema.parse(input);
    if (request.provider !== this.provider) throw new Error("media_connector_provider_mismatch");
    requireModel(request.model, "grok-imagine-video-1.5");
    assertAllowedOutputPath(request.outputPath);
    const response = await this.send(`${this.endpoint}/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
        ...(request.durationSeconds ? { duration: request.durationSeconds } : {}),
        ...(request.resolution ? { resolution: request.resolution } : {}),
      }),
    });
    return readJob(await response.json());
  }

  public async poll(requestId: string): Promise<VideoJob> {
    const response = await this.send(`${this.endpoint}/${encodeURIComponent(requestId)}`, {
      headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json" },
    });
    return readJob(await response.json());
  }

  /**
   * Downloads a finished render to the caller's path.
   *
   * The URL arrives on an authenticated provider response rather than from a
   * user, but it is still a URL this process is about to fetch: the host is
   * checked against the provider's own domain, redirects are refused, and the
   * declared and actual lengths are both bounded. A provider that is
   * compromised or confused must not become an SSRF primitive.
   */
  public async retrieve(job: VideoJob, request: VideoGenerationRequest): Promise<MediaGenerationResult> {
    if (job.status !== "done" || job.videoUrl === undefined) {
      throw new Error(`media_connector_video_not_ready:${job.status}`);
    }
    assertAllowedOutputPath(request.outputPath);
    const url = new URL(job.videoUrl);
    if (url.protocol !== "https:" || !GROK_VIDEO_HOSTS.test(url.hostname)) {
      throw new Error("media_connector_video_host_refused");
    }
    const response = await this.transport(url, { redirect: "error" });
    if (!response.ok) throw new Error(`media_connector_provider_error:${String(response.status)}`);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MEDIA_ARTIFACT_BYTES_MAX) throw new Error("media_connector_artifact_too_large");
    const bytes = new Uint8Array(await response.arrayBuffer());
    return writeArtifact(request, {
      bytes,
      mimeType: mimeTypeFor(request.outputPath),
      requestId: job.requestId,
    });
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const response = await this.transport(url, init);
    if (!response.ok) throw new Error(`media_connector_provider_error:${String(response.status)}`);
    return response;
  }
}

const GrokVideoResponseSchema = z.object({
  request_id: z.string().min(1),
  status: VideoJobStatusSchema,
  video: z.object({ url: z.string().min(1) }).optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
});

function readJob(body: unknown): VideoJob {
  const parsed = GrokVideoResponseSchema.parse(body);
  const error = parsed.error?.message ?? parsed.error?.code;
  return {
    requestId: parsed.request_id,
    status: parsed.status,
    ...(parsed.video?.url ? { videoUrl: parsed.video.url } : {}),
    ...(error ? { error: error.slice(0, 500) } : {}),
  };
}

const OpenAiResponseSchema = z.object({ data: z.array(z.object({ b64_json: z.string().min(1) })).min(1) });
const GrokImageResponseSchema = z.object({
  data: z.array(z.object({ b64_json: z.string().min(1) })).min(1),
});
const GoogleResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({
          parts: z.array(
            z.object({
              inlineData: z.object({ data: z.string().min(1), mimeType: z.string().min(1) }).optional(),
            }),
          ),
        }),
      }),
    )
    .min(1),
});

/**
 * Projects a generation action through compiled doctrine.
 *
 * Both kinds are read-class for the same reason: they create a caller-selected
 * local artifact and mutate no external authority. They are separate actions so
 * an operator can allow pictures and deny video — the cost profiles are nothing
 * alike — without editing this package.
 */
export function projectMediaGenerationGrant(
  doctrine: CompiledDoctrine | undefined,
  input: { principalId: string; kind?: MediaKind },
): boolean {
  if (!doctrine) return false;
  const action = input.kind === "video" ? MEDIA_GENERATE_VIDEO_ACTION : MEDIA_GENERATE_IMAGE_ACTION;
  const classify = createConnectorActionClassifier([
    { action: MEDIA_GENERATE_IMAGE_ACTION, riskClass: "read" },
    { action: MEDIA_GENERATE_VIDEO_ACTION, riskClass: "read" },
  ]);
  const request: ActionRequest = {
    id: `media-projection:${action}`,
    principal: { kind: "worker", id: input.principalId },
    action,
    resource: { type: "media-generation", id: input.kind ?? "image" },
    context: {
      missionId: "media-readiness",
      risk: "low",
      profileHash: doctrine.profileHash,
    },
  };
  return decideAction(doctrine, request, classify(action)).effect === "allow";
}

export function assertAllowedOutputPath(path: string): void {
  const normalized = resolve(path).toLowerCase();
  const components = normalized.split(sep);
  const pixelArtComponent = /^(?:pixel[-_ ]?art|sprites?|atlases?)$/u;
  if (extname(normalized) === ".aseprite" || components.some((part) => pixelArtComponent.test(part))) {
    throw new Error(`media_connector_pixel_art_path_refused:${basename(path)}`);
  }
}

/**
 * Reads a local image into the data URI the edit endpoints accept.
 *
 * The caller resolves the path; this only turns bytes into the wire form, so
 * the package still never chooses what to read.
 */
export async function readSourceImageDataUrl(path: string): Promise<string> {
  const bytes = await readFile(path);
  if (bytes.byteLength > MEDIA_ARTIFACT_BYTES_MAX) throw new Error("media_connector_artifact_too_large");
  return `data:${mimeTypeFor(path)};base64,${bytes.toString("base64")}`;
}

function inlineDataPart(sourceImage: string): { inlineData: { data: string; mimeType: string } } {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(sourceImage);
  if (!match) throw new Error("media_connector_source_image_must_be_data_uri");
  return { inlineData: { mimeType: match[1]!, data: match[2]! } };
}

function decodeDataUri(value: string): { bytes: Uint8Array; mimeType: string } {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(value);
  if (!match) throw new Error("media_connector_source_image_must_be_data_uri");
  return { bytes: decodeBase64(match[2]!), mimeType: match[1]! };
}

function decodeBase64(value: string): Uint8Array {
  return Buffer.from(value, "base64");
}

function outputFormat(path: string): "png" | "jpeg" | "webp" {
  const extension = extname(path).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "jpeg";
  if (extension === ".webp") return "webp";
  return "png";
}

function mimeTypeFor(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".webm") return "video/webm";
  const format = outputFormat(path);
  return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

function requireModel(actual: string, expected: string): void {
  if (actual !== expected) throw new Error(`media_connector_model_unsupported:${actual}`);
}

function providerRequestId(response: Response): { requestId?: string } {
  const requestId = response.headers.get("x-request-id")?.trim();
  return requestId ? { requestId } : {};
}
