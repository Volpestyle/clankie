import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { afterEach, describe, expect, it } from "vitest";
import {
  GoogleImageAdapter,
  GrokImageAdapter,
  GrokVideoAdapter,
  MediaGenerationRequestSchema,
  OpenAiImageAdapter,
  projectMediaGenerationGrant,
  type ImageGenerationRequest,
  type MediaFetch,
  type VideoGenerationRequest,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("media generation schemas", () => {
  it("validates a versioned provider-neutral image request", () => {
    expect(
      MediaGenerationRequestSchema.parse({
        schemaVersion: 2,
        kind: "image",
        prompt: "A garden robot",
        aspectRatio: "16:9",
        provider: "google",
        model: "gemini-3.1-flash-image",
        outputPath: "/tmp/garden.png",
      }),
    ).toMatchObject({ kind: "image", provider: "google" });
  });

  it("refuses a request stamped with the superseded schema version", () => {
    expect(() =>
      MediaGenerationRequestSchema.parse({
        schemaVersion: 1,
        kind: "image",
        prompt: "A garden robot",
        provider: "openai",
        model: "gpt-image-2",
        outputPath: "/tmp/garden.png",
      }),
    ).toThrow();
  });

  it("validates video request semantics that an image request has no field for", () => {
    expect(
      MediaGenerationRequestSchema.parse({
        schemaVersion: 2,
        kind: "video",
        prompt: "A garden robot waving",
        aspectRatio: "16:9",
        durationSeconds: 6,
        resolution: "720p",
        provider: "grok",
        model: "grok-imagine-video-1.5",
        outputPath: "/tmp/garden.mp4",
      }),
    ).toMatchObject({ kind: "video", durationSeconds: 6 });
    // Duration is bounded by the provider's own range, not left to the caller.
    expect(() =>
      MediaGenerationRequestSchema.parse({
        schemaVersion: 2,
        kind: "video",
        prompt: "A garden robot waving",
        durationSeconds: 60,
        provider: "grok",
        model: "grok-imagine-video-1.5",
        outputPath: "/tmp/garden.mp4",
      }),
    ).toThrow();
    // Image-only fields stay image-only.
    expect(() =>
      MediaGenerationRequestSchema.parse({
        schemaVersion: 2,
        kind: "video",
        prompt: "A garden robot waving",
        size: "1024x1024",
        provider: "grok",
        model: "grok-imagine-video-1.5",
        outputPath: "/tmp/garden.mp4",
      }),
    ).toThrow();
  });
});

describe("provider adapters", () => {
  it("shapes an OpenAI request and writes a hashed artifact", async () => {
    const outputPath = await output("openai.png");
    const transport = recorder({ data: [{ b64_json: imageBytes.toString("base64") }] });
    const result = await new OpenAiImageAdapter({ apiKey: "openai-secret", fetch: transport.fetch }).generate(
      request({ provider: "openai", model: "gpt-image-2", outputPath, size: "1536x1024" }),
    );
    expect(transport.calls[0]).toMatchObject({
      url: "https://api.openai.com/v1/images/generations",
      headers: { authorization: "Bearer openai-secret" },
      body: { model: "gpt-image-2", prompt: "A garden robot", size: "1536x1024", output_format: "png" },
    });
    expect(await readFile(outputPath)).toEqual(imageBytes);
    expect(result.sha256).toBe(createHash("sha256").update(imageBytes).digest("hex"));
    expect(result).toMatchObject({ provider: "openai", model: "gpt-image-2", mimeType: "image/png" });
  });

  it("shapes a Google request without putting the credential in the URL", async () => {
    const outputPath = await output("google.png");
    const transport = recorder({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { data: imageBytes.toString("base64"), mimeType: "image/png" } }],
          },
        },
      ],
    });
    await new GoogleImageAdapter({ apiKey: "google-secret", fetch: transport.fetch }).generate(
      request({
        provider: "google",
        model: "gemini-3.1-flash-image",
        outputPath,
        aspectRatio: "16:9",
      }),
    );
    expect(transport.calls[0]).toMatchObject({
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent",
      headers: { "x-goog-api-key": "google-secret" },
      body: {
        contents: [{ role: "user", parts: [{ text: "A garden robot" }] }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "16:9" } },
      },
    });
    expect(transport.calls[0]?.url).not.toContain("google-secret");
  });

  it("shapes a Grok request", async () => {
    const outputPath = await output("grok.webp");
    const transport = recorder({ data: [{ b64_json: imageBytes.toString("base64") }] });
    await new GrokImageAdapter({ apiKey: "grok-secret", fetch: transport.fetch }).generate(
      request({
        provider: "grok",
        model: "grok-imagine-image-quality",
        outputPath,
        aspectRatio: "3:2",
      }),
    );
    expect(transport.calls[0]).toMatchObject({
      url: "https://api.x.ai/v1/images/generations",
      headers: { authorization: "Bearer grok-secret" },
      body: {
        model: "grok-imagine-image-quality",
        prompt: "A garden robot",
        aspect_ratio: "3:2",
        response_format: "b64_json",
      },
    });
  });

  it("refuses product pixel-art paths before calling a provider", async () => {
    const transport = recorder({ data: [{ b64_json: imageBytes.toString("base64") }] });
    await expect(
      new OpenAiImageAdapter({ apiKey: "secret", fetch: transport.fetch }).generate(
        request({
          provider: "openai",
          model: "gpt-image-2",
          outputPath: "/tmp/clankie-app/assets/sprites/clankie.png",
        }),
      ),
    ).rejects.toThrow(/pixel_art_path_refused/u);
    expect(transport.calls).toEqual([]);
  });
});

describe("image editing", () => {
  it("routes to the edit endpoint only when a source image is supplied", async () => {
    const outputPath = await output("edited.png");
    const transport = recorder({ data: [{ b64_json: imageBytes.toString("base64") }] });
    await new GrokImageAdapter({ apiKey: "grok-secret", fetch: transport.fetch }).generate(
      request({
        provider: "grok",
        model: "grok-imagine-image-quality",
        outputPath,
        sourceImage: "data:image/png;base64,c291cmNl",
      }),
    );
    expect(transport.calls[0]?.url).toBe("https://api.x.ai/v1/images/edits");
    expect(transport.calls[0]?.body).toMatchObject({
      image: { type: "image_url", url: "data:image/png;base64,c291cmNl" },
    });
  });

  it("keeps generation on the generations endpoint", async () => {
    const outputPath = await output("fresh.png");
    const transport = recorder({ data: [{ b64_json: imageBytes.toString("base64") }] });
    await new OpenAiImageAdapter({ apiKey: "secret", fetch: transport.fetch }).generate(
      request({ provider: "openai", model: "gpt-image-2", outputPath }),
    );
    expect(transport.calls[0]?.url).toBe("https://api.openai.com/v1/images/generations");
    expect(transport.calls[0]?.body).not.toHaveProperty("image");
  });
});

describe("video jobs", () => {
  it("starts a render and reports the job rather than blocking on it", async () => {
    const transport = recorder({ request_id: "job-1", status: "pending" });
    const job = await new GrokVideoAdapter({ apiKey: "grok-secret", fetch: transport.fetch }).start(
      videoRequest({ outputPath: "/tmp/clip.mp4" }),
    );
    expect(transport.calls[0]).toMatchObject({
      url: "https://api.x.ai/v1/videos/generations",
      body: { model: "grok-imagine-video-1.5", duration: 6, resolution: "720p", aspect_ratio: "16:9" },
    });
    expect(job).toMatchObject({ requestId: "job-1", status: "pending" });
  });

  it("refuses to retrieve a render that is not done", async () => {
    const transport = recorder({ request_id: "job-1", status: "pending" });
    const adapter = new GrokVideoAdapter({ apiKey: "grok-secret", fetch: transport.fetch });
    await expect(
      adapter.retrieve({ requestId: "job-1", status: "pending" }, videoRequest({ outputPath: "/tmp/x.mp4" })),
    ).rejects.toThrow(/video_not_ready/u);
  });

  it("refuses a finished render hosted somewhere other than the provider", async () => {
    const adapter = new GrokVideoAdapter({ apiKey: "grok-secret", fetch: recorder({}).fetch });
    await expect(
      adapter.retrieve(
        { requestId: "job-1", status: "done", videoUrl: "https://attacker.example/clip.mp4" },
        videoRequest({ outputPath: "/tmp/x.mp4" }),
      ),
    ).rejects.toThrow(/video_host_refused/u);
  });

  it("downloads a finished render and hashes the exact bytes written", async () => {
    const outputPath = await output("clip.mp4");
    const videoBytes = Buffer.from("rendered-video-fixture");
    const adapter = new GrokVideoAdapter({
      apiKey: "grok-secret",
      fetch: (input) => {
        expect(input.toString()).toBe("https://vidgen.x.ai/abc/video.mp4");
        return Promise.resolve(new Response(videoBytes, { status: 200 }));
      },
    });
    const result = await adapter.retrieve(
      { requestId: "job-1", status: "done", videoUrl: "https://vidgen.x.ai/abc/video.mp4" },
      videoRequest({ outputPath }),
    );
    expect(result).toMatchObject({ kind: "video", mimeType: "video/mp4", provider: "grok" });
    expect(result.sha256).toBe(createHash("sha256").update(videoBytes).digest("hex"));
    expect(await readFile(outputPath)).toEqual(videoBytes);
  });
});

describe("doctrine projection", () => {
  it("fails closed without compiled doctrine", () => {
    expect(projectMediaGenerationGrant(undefined, { principalId: "test-worker" })).toBe(false);
  });

  it("allows media generation through the read risk class", async () => {
    const path = join(import.meta.dirname, "..", "..", "..", "doctrine", "profiles", "self-build-lab.yaml");
    const doctrine = compileDoctrine([await loadDoctrineFile(path)]);
    expect(projectMediaGenerationGrant(doctrine, { principalId: "test-worker" })).toBe(true);
    expect(projectMediaGenerationGrant(doctrine, { principalId: "test-worker", kind: "video" })).toBe(true);
  });

  it("projects each kind as its own action so one can be denied alone", async () => {
    const path = join(import.meta.dirname, "..", "..", "..", "doctrine", "profiles", "self-build-lab.yaml");
    const base = await loadDoctrineFile(path);
    const doctrine = compileDoctrine([
      { ...base, actions: { ...base.actions, "media.generate.video": { default: "deny", rules: [] } } },
    ]);
    expect(projectMediaGenerationGrant(doctrine, { principalId: "test-worker" })).toBe(true);
    expect(projectMediaGenerationGrant(doctrine, { principalId: "test-worker", kind: "video" })).toBe(false);
  });
});

function videoRequest(overrides: Partial<VideoGenerationRequest>): VideoGenerationRequest {
  return {
    schemaVersion: 2,
    kind: "video",
    prompt: "A garden robot waving",
    aspectRatio: "16:9",
    durationSeconds: 6,
    resolution: "720p",
    provider: "grok",
    model: "grok-imagine-video-1.5",
    outputPath: "/tmp/generated.mp4",
    ...overrides,
  };
}

const imageBytes = Buffer.from("generated-image-fixture");

function request(overrides: Partial<ImageGenerationRequest>): ImageGenerationRequest {
  return {
    schemaVersion: 2,
    kind: "image",
    prompt: "A garden robot",
    provider: "openai",
    model: "gpt-image-2",
    outputPath: "/tmp/generated.png",
    ...overrides,
  };
}

async function output(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clankie-media-connector-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

function recorder(responseBody: unknown): {
  fetch: MediaFetch;
  calls: Array<{ url: string; headers: Record<string, string>; body: unknown }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  return {
    calls,
    fetch: (input, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      calls.push({
        url: input.toString(),
        headers,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "content-type": "application/json", "x-request-id": "provider-request-1" },
        }),
      );
    },
  };
}
