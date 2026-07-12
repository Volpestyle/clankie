import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { createConnectorActionClassifier, decideAction, type CompiledDoctrine } from "@clankie/doctrine";
import type { ActionRequest } from "@clankie/protocol";
import { z } from "zod";

export const MEDIA_GENERATION_SCHEMA_VERSION = 1;
export const MEDIA_GENERATE_IMAGE_ACTION = "media.generate.image";

export const MediaKindSchema = z.enum(["image"]);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const MediaProviderSchema = z.enum(["openai", "google", "grok"]);
export type MediaProvider = z.infer<typeof MediaProviderSchema>;

export const MediaGenerationRequestSchema = z
  .object({
    schemaVersion: z.literal(MEDIA_GENERATION_SCHEMA_VERSION),
    kind: MediaKindSchema,
    prompt: z.string().trim().min(1).max(32_000),
    size: z.string().trim().min(1).max(64).optional(),
    aspectRatio: z
      .string()
      .trim()
      .regex(/^\d{1,2}:\d{1,2}$/u)
      .optional(),
    provider: MediaProviderSchema,
    model: z.string().trim().min(1).max(200),
    outputPath: z.string().trim().min(1),
  })
  .strict();
export type MediaGenerationRequest = z.infer<typeof MediaGenerationRequestSchema>;

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
  generate(request: MediaGenerationRequest): Promise<MediaGenerationResult>;
}

export interface MediaAdapterConfig {
  apiKey: string;
  fetch?: MediaFetch;
  endpoint?: string;
}

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

  public async generate(input: MediaGenerationRequest): Promise<MediaGenerationResult> {
    const request = MediaGenerationRequestSchema.parse(input);
    if (request.provider !== this.provider) throw new Error("media_connector_provider_mismatch");
    assertAllowedOutputPath(request.outputPath);
    const generated = await this.fetchImage(request);
    if (generated.bytes.byteLength === 0) throw new Error("media_connector_empty_artifact");
    const artifactPath = resolve(request.outputPath);
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, generated.bytes, { mode: 0o600 });
    return MediaGenerationResultSchema.parse({
      schemaVersion: MEDIA_GENERATION_SCHEMA_VERSION,
      kind: request.kind,
      artifactPath,
      sha256: createHash("sha256").update(generated.bytes).digest("hex"),
      provider: this.provider,
      model: request.model,
      ...(generated.requestId ? { providerRequestId: generated.requestId } : {}),
      mimeType: generated.mimeType,
      bytes: generated.bytes.byteLength,
    });
  }

  protected abstract fetchImage(request: MediaGenerationRequest): Promise<GeneratedImage>;

  protected async send(url: string, init: RequestInit): Promise<Response> {
    const response = await this.transport(url, init);
    if (!response.ok) throw new Error(`media_connector_provider_error:${String(response.status)}`);
    return response;
  }
}

interface GeneratedImage {
  bytes: Uint8Array;
  mimeType: string;
  requestId?: string;
}

export class OpenAiImageAdapter extends FetchMediaAdapter {
  public readonly provider = "openai" as const;

  protected async fetchImage(request: MediaGenerationRequest): Promise<GeneratedImage> {
    requireModel(request.model, "gpt-image-2");
    const response = await this.send(this.endpoint ?? "https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        ...(request.size ? { size: request.size } : {}),
        output_format: outputFormat(request.outputPath),
      }),
    });
    const body = OpenAiResponseSchema.parse(await response.json());
    return {
      bytes: decodeBase64(body.data[0]!.b64_json),
      mimeType: mimeTypeFor(request.outputPath),
      ...providerRequestId(response),
    };
  }
}

export class GoogleImageAdapter extends FetchMediaAdapter {
  public readonly provider = "google" as const;

  protected async fetchImage(request: MediaGenerationRequest): Promise<GeneratedImage> {
    requireModel(request.model, "gemini-3.1-flash-image");
    const base = this.endpoint ?? "https://generativelanguage.googleapis.com/v1beta";
    const url = `${base}/models/${encodeURIComponent(request.model)}:generateContent`;
    const response = await this.send(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: request.prompt }] }],
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

  protected async fetchImage(request: MediaGenerationRequest): Promise<GeneratedImage> {
    requireModel(request.model, "grok-imagine-image-quality");
    const response = await this.send(this.endpoint ?? "https://api.x.ai/v1/images/generations", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
        response_format: "b64_json",
      }),
    });
    const body = GrokResponseSchema.parse(await response.json());
    return {
      bytes: decodeBase64(body.data[0]!.b64_json),
      mimeType: mimeTypeFor(request.outputPath),
      ...providerRequestId(response),
    };
  }
}

const OpenAiResponseSchema = z.object({ data: z.array(z.object({ b64_json: z.string().min(1) })).min(1) });
const GrokResponseSchema = z.object({ data: z.array(z.object({ b64_json: z.string().min(1) })).min(1) });
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

export function projectMediaGenerationGrant(
  doctrine: CompiledDoctrine | undefined,
  input: { principalId: string },
): boolean {
  if (!doctrine) return false;
  const classify = createConnectorActionClassifier([
    { action: MEDIA_GENERATE_IMAGE_ACTION, riskClass: "read" },
  ]);
  const request: ActionRequest = {
    id: `media-projection:${MEDIA_GENERATE_IMAGE_ACTION}`,
    principal: { kind: "worker", id: input.principalId },
    action: MEDIA_GENERATE_IMAGE_ACTION,
    resource: { type: "media-generation", id: "image" },
    context: {
      missionId: "media-readiness",
      risk: "low",
      profileHash: doctrine.profileHash,
    },
  };
  return decideAction(doctrine, request, classify(MEDIA_GENERATE_IMAGE_ACTION)).effect === "allow";
}

export function assertAllowedOutputPath(path: string): void {
  const normalized = resolve(path).toLowerCase();
  const components = normalized.split(sep);
  const pixelArtComponent = /^(?:pixel[-_ ]?art|sprites?|atlases?)$/u;
  if (extname(normalized) === ".aseprite" || components.some((part) => pixelArtComponent.test(part))) {
    throw new Error(`media_connector_pixel_art_path_refused:${basename(path)}`);
  }
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
