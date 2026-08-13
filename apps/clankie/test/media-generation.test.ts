import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore, ProviderCredential, RedactedCredential } from "@clankie/credential-broker";
import { isGeneratedMediaRef } from "@clankie/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ConfiguredMediaGenerator } from "../src/media-generation.ts";

/**
 * The control plane is where making a picture happens (ADR 0085), so this is
 * where the two properties that matter get proven: a refusal is always a
 * sayable reason rather than an exception, and the reference handed back is one
 * the conversational-attach path will accept — nothing else is.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("making a picture", () => {
  it("writes it where the attachment resolver can find it and returns a generated-media reference", async () => {
    const pixels = Buffer.from("generated-image-fixture");
    const workspace = await workspaceWith({ image_model: "openai/gpt-image-2" });
    const generator = new ConfiguredMediaGenerator({
      credentials: store({ openai: "openai-secret" }),
      attachmentRoot: workspace.attachmentRoot,
      configCwd: workspace.configCwd,
      environment: workspace.environment,
      fetchImpl: () => Promise.resolve(Response.json({ data: [{ b64_json: pixels.toString("base64") }] })),
    });

    const result = await generator.generateImage({ schemaVersion: 1, prompt: "a garden robot" });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;

    expect(isGeneratedMediaRef(result.artifactRef)).toBe(true);
    expect(result.artifactRef).toContain(createHash("sha256").update(pixels).digest("hex"));
    expect(result).toMatchObject({ provider: "openai", model: "gpt-image-2", mimeType: "image/png" });
    // Under the root, in the one directory the reply path trusts.
    expect(await readFile(join(workspace.attachmentRoot, "generated", result.filename))).toEqual(pixels);
  });

  it("refuses in words when no image model is configured", async () => {
    const workspace = await workspaceWith({});
    const generator = new ConfiguredMediaGenerator({
      credentials: store({ openai: "openai-secret" }),
      attachmentRoot: workspace.attachmentRoot,
      configCwd: workspace.configCwd,
      environment: workspace.environment,
      fetchImpl: () => Promise.reject(new Error("must not reach a provider")),
    });

    expect(await generator.generateImage({ schemaVersion: 1, prompt: "a garden robot" })).toMatchObject({
      outcome: "refused",
      reason: "no_model_configured",
    });
  });

  it("refuses when the configured provider has no stored credential", async () => {
    const workspace = await workspaceWith({ image_model: "openai/gpt-image-2" });
    const generator = new ConfiguredMediaGenerator({
      credentials: store({}),
      attachmentRoot: workspace.attachmentRoot,
      configCwd: workspace.configCwd,
      environment: workspace.environment,
      fetchImpl: () => Promise.reject(new Error("must not reach a provider")),
    });

    expect(await generator.generateImage({ schemaVersion: 1, prompt: "a garden robot" })).toMatchObject({
      outcome: "refused",
      reason: "credential_unavailable",
    });
  });

  it("falls back to the provider's declared environment variable", async () => {
    const workspace = await workspaceWith({ image_model: "openai/gpt-image-2" });
    let seenAuthorization: string | undefined;
    const generator = new ConfiguredMediaGenerator({
      credentials: store({}),
      attachmentRoot: workspace.attachmentRoot,
      configCwd: workspace.configCwd,
      environment: { ...workspace.environment, OPENAI_API_KEY: "from-environment" },
      fetchImpl: (_input, init) => {
        seenAuthorization = new Headers(init?.headers).get("authorization") ?? undefined;
        return Promise.resolve(Response.json({ data: [{ b64_json: Buffer.from("x").toString("base64") }] }));
      },
    });

    expect(await generator.generateImage({ schemaVersion: 1, prompt: "a robot" })).toMatchObject({
      outcome: "ok",
    });
    expect(seenAuthorization).toBe("Bearer from-environment");
  });

  it("edits only media it made, and reads those bytes back as the source", async () => {
    const workspace = await workspaceWith({ image_model: "openai/gpt-image-2" });
    const original = Buffer.from("the-first-picture");
    await mkdir(join(workspace.attachmentRoot, "generated"), { recursive: true });
    await writeFile(join(workspace.attachmentRoot, "generated", "first.png"), original);
    let uploaded: Buffer | undefined;
    let sentPrompt: unknown;
    const generator = new ConfiguredMediaGenerator({
      credentials: store({ openai: "openai-secret" }),
      attachmentRoot: workspace.attachmentRoot,
      configCwd: workspace.configCwd,
      environment: workspace.environment,
      fetchImpl: async (input, init) => {
        expect(input.toString()).toBe("https://api.openai.com/v1/images/edits");
        // The edits endpoint is multipart with the source as an uploaded file,
        // unlike `/generations`, which is JSON.
        const form = init?.body as FormData;
        expect(form).toBeInstanceOf(FormData);
        sentPrompt = form.get("prompt");
        uploaded = Buffer.from(await (form.get("image[]") as File).arrayBuffer());
        return Response.json({ data: [{ b64_json: Buffer.from("edited").toString("base64") }] });
      },
    });

    const result = await generator.generateImage({
      schemaVersion: 1,
      prompt: "make the sky orange",
      sourceRef: `sha256:${createHash("sha256").update(original).digest("hex")}:generated/first.png`,
    });
    expect(result.outcome).toBe("ok");
    expect(sentPrompt).toBe("make the sky orange");
    // The bytes he made earlier, read back off disk and uploaded verbatim.
    expect(uploaded).toEqual(original);
  });
});

describe("rendering a clip", () => {
  it("hands back the job rather than holding the call open forever", async () => {
    const workspace = await workspaceWith({ video_model: "xai/grok-imagine-video-1.5" });
    const generator = new ConfiguredMediaGenerator({
      credentials: store({ xai: "xai-secret" }),
      attachmentRoot: workspace.attachmentRoot,
      configCwd: workspace.configCwd,
      environment: workspace.environment,
      videoWaitMs: 10,
      pollIntervalMs: 1,
      sleep: () => Promise.resolve(),
      fetchImpl: () => Promise.resolve(Response.json({ request_id: "job-1", status: "pending" })),
    });

    expect(
      await generator.generateVideo({ schemaVersion: 1, prompt: "a robot waving", durationSeconds: 6 }),
    ).toMatchObject({ outcome: "pending", requestId: "job-1" });
  });

  it("resumes a render by id instead of starting a second one", async () => {
    const workspace = await workspaceWith({ video_model: "xai/grok-imagine-video-1.5" });
    const calls: string[] = [];
    const clip = Buffer.from("rendered-clip");
    const generator = new ConfiguredMediaGenerator({
      credentials: store({ xai: "xai-secret" }),
      attachmentRoot: workspace.attachmentRoot,
      configCwd: workspace.configCwd,
      environment: workspace.environment,
      sleep: () => Promise.resolve(),
      fetchImpl: (input) => {
        const url = input.toString();
        calls.push(url);
        if (url.endsWith("/videos/job-1")) {
          return Promise.resolve(
            Response.json({
              request_id: "job-1",
              status: "done",
              video: { url: "https://vidgen.x.ai/job-1/video.mp4" },
            }),
          );
        }
        return Promise.resolve(new Response(clip, { status: 200 }));
      },
    });

    const result = await generator.generateVideo({ schemaVersion: 1, requestId: "job-1" });
    expect(result).toMatchObject({ outcome: "ok", mimeType: "video/mp4" });
    // Never posted a new render: only the status read and the download.
    expect(calls.some((url) => url.endsWith("/videos/generations"))).toBe(false);
    if (result.outcome === "ok") expect(isGeneratedMediaRef(result.artifactRef)).toBe(true);
  });

  it("turns a failed render into a reason he can say", async () => {
    const workspace = await workspaceWith({ video_model: "xai/grok-imagine-video-1.5" });
    const generator = new ConfiguredMediaGenerator({
      credentials: store({ xai: "xai-secret" }),
      attachmentRoot: workspace.attachmentRoot,
      configCwd: workspace.configCwd,
      environment: workspace.environment,
      sleep: () => Promise.resolve(),
      fetchImpl: () =>
        Promise.resolve(
          Response.json({ request_id: "job-1", status: "failed", error: { message: "moderation" } }),
        ),
    });

    expect(await generator.generateVideo({ schemaVersion: 1, prompt: "something" })).toMatchObject({
      outcome: "refused",
      reason: "provider_failed",
      detail: "moderation",
    });
  });
});

interface Workspace {
  readonly attachmentRoot: string;
  readonly configCwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

/** A config home and attachment root of its own, so no test reads the developer's real `/model` settings. */
async function workspaceWith(config: Record<string, string>): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "clankie-media-"));
  roots.push(root);
  const configHome = join(root, "config");
  await mkdir(join(configHome, "clankie"), { recursive: true });
  await writeFile(join(configHome, "clankie", "clankie.json"), JSON.stringify(config));
  const configCwd = join(root, "workspace");
  await mkdir(configCwd, { recursive: true });
  return {
    attachmentRoot: join(root, "artifacts"),
    configCwd,
    environment: { XDG_CONFIG_HOME: configHome },
  };
}

function store(keys: Record<string, string>): CredentialStore {
  return {
    get: (providerId) =>
      Promise.resolve(
        keys[providerId] === undefined
          ? undefined
          : ({ type: "api", key: keys[providerId] } satisfies ProviderCredential),
      ),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(false),
    list: () => Promise.resolve({} as Record<string, RedactedCredential>),
  };
}
