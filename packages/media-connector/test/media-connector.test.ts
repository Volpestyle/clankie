import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { afterEach, describe, expect, it } from "vitest";
import {
  GoogleImageAdapter,
  GrokImageAdapter,
  MediaGenerationRequestSchema,
  OpenAiImageAdapter,
  projectMediaGenerationGrant,
  type MediaFetch,
  type MediaGenerationRequest,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("media generation schemas", () => {
  it("validates a versioned provider-neutral image request", () => {
    expect(
      MediaGenerationRequestSchema.parse({
        schemaVersion: 1,
        kind: "image",
        prompt: "A garden robot",
        aspectRatio: "16:9",
        provider: "google",
        model: "gemini-3.1-flash-image",
        outputPath: "/tmp/garden.png",
      }),
    ).toMatchObject({ kind: "image", provider: "google" });
    expect(() =>
      MediaGenerationRequestSchema.parse({
        schemaVersion: 2,
        kind: "video",
        prompt: "future request",
        provider: "google",
        model: "future-model",
        outputPath: "/tmp/future.mp4",
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

describe("doctrine projection", () => {
  it("fails closed without compiled doctrine", () => {
    expect(projectMediaGenerationGrant(undefined, { principalId: "test-worker" })).toBe(false);
  });

  it("allows media generation through the read risk class", async () => {
    const path = join(import.meta.dirname, "..", "..", "..", "doctrine", "profiles", "self-build-lab.yaml");
    expect(
      projectMediaGenerationGrant(compileDoctrine([await loadDoctrineFile(path)]), {
        principalId: "test-worker",
      }),
    ).toBe(true);
  });
});

const imageBytes = Buffer.from("generated-image-fixture");

function request(overrides: Partial<MediaGenerationRequest>): MediaGenerationRequest {
  return {
    schemaVersion: 1,
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
