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

  it("uses a SuperGrok subscription over a metered xAI key for pictures", async () => {
    const workspace = await workspaceWith({ image_model: "xai/grok-imagine-image-quality" });
    const pixels = Buffer.from("subscription-image");
    let seenAuthorization: string | undefined;
    const credentials: CredentialStore = {
      get: (providerId) =>
        Promise.resolve(
          providerId === "xai"
            ? {
                type: "oauth",
                access: "supergrok-access",
                refresh: "supergrok-refresh",
                expires: Date.now() + 600_000,
              }
            : undefined,
        ),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(false),
      list: () => Promise.resolve({} as Record<string, RedactedCredential>),
    };
    const generator = new ConfiguredMediaGenerator({
      credentials,
      attachmentRoot: workspace.attachmentRoot,
      configCwd: workspace.configCwd,
      environment: { ...workspace.environment, XAI_API_KEY: "metered-must-not-win" },
      fetchImpl: (_input, init) => {
        seenAuthorization = new Headers(init?.headers).get("authorization") ?? undefined;
        return Promise.resolve(Response.json({ data: [{ b64_json: pixels.toString("base64") }] }));
      },
    });

    expect(await generator.generateImage({ schemaVersion: 1, prompt: "a garden robot" })).toMatchObject({
      outcome: "ok",
      provider: "xai",
      model: "grok-imagine-image-quality",
    });
    expect(seenAuthorization).toBe("Bearer supergrok-access");
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

/**
 * A render that outlives its call (ADR 0094). The turn is the clock: nothing
 * polls in the background, so each of these drives the check the way a turn in
 * that room would.
 */
describe("a render that outlives the call that started it", () => {
  it("lands on a later turn in the room that asked, and only that room", async () => {
    const workspace = await workspaceWith({ video_model: "xai/grok-imagine-video-1.5" });
    const clip = Buffer.from("rendered-clip");
    let status = "pending";
    const generator = new ConfiguredMediaGenerator({
      credentials: store({ xai: "xai-secret" }),
      attachmentRoot: workspace.attachmentRoot,
      configCwd: workspace.configCwd,
      environment: workspace.environment,
      videoWaitMs: 10,
      pollIntervalMs: 1,
      sleep: () => Promise.resolve(),
      fetchImpl: (input) => {
        const url = input.toString();
        if (url.endsWith("video.mp4")) return Promise.resolve(new Response(clip, { status: 200 }));
        return Promise.resolve(
          Response.json({
            request_id: "job-1",
            status,
            ...(status === "done" ? { video: { url: "https://vidgen.x.ai/job-1/video.mp4" } } : {}),
          }),
        );
      },
    });

    const pending = await generator.generateVideo(
      { schemaVersion: 1, prompt: "a robot waving" },
      { room: "discord_presence:guild:general" },
    );
    expect(pending).toMatchObject({ outcome: "pending", requestId: "job-1" });

    // Still rendering: a turn in the room is told nothing.
    expect(await generator.finishedRenders("discord_presence:guild:general")).toEqual([]);

    status = "done";
    // Another room's turn never learns about it, and never collects it.
    expect(await generator.finishedRenders("discord_presence:guild:other")).toEqual([]);

    const landed = await generator.finishedRenders("discord_presence:guild:general");
    expect(landed).toHaveLength(1);
    expect(landed[0]).toMatchObject({ requestId: "job-1", prompt: "a robot waving", outcome: "ok" });
  });

  it("hands the finished video over without re-downloading it, then stops mentioning it", async () => {
    const workspace = await workspaceWith({ video_model: "xai/grok-imagine-video-1.5" });
    const clip = Buffer.from("rendered-clip");
    const downloads: string[] = [];
    let status = "pending";
    const generator = new ConfiguredMediaGenerator({
      credentials: store({ xai: "xai-secret" }),
      attachmentRoot: workspace.attachmentRoot,
      configCwd: workspace.configCwd,
      environment: workspace.environment,
      videoWaitMs: 10,
      pollIntervalMs: 1,
      sleep: () => Promise.resolve(),
      fetchImpl: (input) => {
        const url = input.toString();
        if (url.endsWith("video.mp4")) {
          downloads.push(url);
          return Promise.resolve(new Response(clip, { status: 200 }));
        }
        return Promise.resolve(
          Response.json({
            request_id: "job-1",
            status,
            ...(status === "done" ? { video: { url: "https://vidgen.x.ai/job-1/video.mp4" } } : {}),
          }),
        );
      },
    });

    await generator.generateVideo({ schemaVersion: 1, prompt: "a robot waving" }, { room: "room-a" });
    status = "done";
    expect(await generator.finishedRenders("room-a")).toHaveLength(1);
    expect(downloads).toHaveLength(1);

    // Collecting it by id returns the stored answer, so the bytes are fetched
    // once however many times he comes back for them.
    const collected = await generator.generateVideo({ schemaVersion: 1, requestId: "job-1" });
    expect(collected).toMatchObject({ outcome: "ok", mimeType: "video/mp4" });
    expect(downloads).toHaveLength(1);

    // And once he has it, the room stops being told it is waiting.
    expect(await generator.finishedRenders("room-a")).toEqual([]);
  });

  it("reports a render that failed after the call gave up, rather than losing it", async () => {
    const workspace = await workspaceWith({ video_model: "xai/grok-imagine-video-1.5" });
    let status = "pending";
    const generator = new ConfiguredMediaGenerator({
      credentials: store({ xai: "xai-secret" }),
      attachmentRoot: workspace.attachmentRoot,
      configCwd: workspace.configCwd,
      environment: workspace.environment,
      videoWaitMs: 10,
      pollIntervalMs: 1,
      sleep: () => Promise.resolve(),
      fetchImpl: () =>
        Promise.resolve(
          Response.json({
            request_id: "job-1",
            status,
            ...(status === "failed" ? { error: { message: "moderation" } } : {}),
          }),
        ),
    });

    await generator.generateVideo({ schemaVersion: 1, prompt: "something" }, { room: "room-a" });
    status = "failed";
    expect(await generator.finishedRenders("room-a")).toMatchObject([
      { requestId: "job-1", outcome: "refused" },
    ]);
    expect(await generator.generateVideo({ schemaVersion: 1, requestId: "job-1" })).toMatchObject({
      outcome: "refused",
      reason: "provider_failed",
      detail: "moderation",
    });
  });

  it("stops mentioning a landed render nobody came back for", async () => {
    const workspace = await workspaceWith({ video_model: "xai/grok-imagine-video-1.5" });
    const clip = Buffer.from("rendered-clip");
    let now = 1_000;
    let status = "pending";
    const generator = new ConfiguredMediaGenerator({
      credentials: store({ xai: "xai-secret" }),
      attachmentRoot: workspace.attachmentRoot,
      configCwd: workspace.configCwd,
      environment: workspace.environment,
      videoWaitMs: 10,
      pollIntervalMs: 1,
      renderRetentionMs: 60_000,
      // A fake clock only bounds the waits if sleeping actually moves it.
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
      now: () => now,
      fetchImpl: (input) => {
        const url = input.toString();
        if (url.endsWith("video.mp4")) return Promise.resolve(new Response(clip, { status: 200 }));
        return Promise.resolve(
          Response.json({
            request_id: "job-1",
            status,
            ...(status === "done" ? { video: { url: "https://vidgen.x.ai/job-1/video.mp4" } } : {}),
          }),
        );
      },
    });

    await generator.generateVideo({ schemaVersion: 1, prompt: "a robot waving" }, { room: "room-a" });
    status = "done";
    expect(await generator.finishedRenders("room-a")).toHaveLength(1);

    now += 60_001;
    expect(await generator.finishedRenders("room-a")).toEqual([]);
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
