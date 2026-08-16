import { DISCORD_PRESENCE_ATTACHMENT_BYTES_MAX, type DiscordPresenceAttachment } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { createDiscordAttachmentResolver, fetchDiscordAttachment } from "../src/discord-attachment-fetch.ts";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

function attachment(overrides: Partial<DiscordPresenceAttachment> = {}): DiscordPresenceAttachment {
  return {
    id: "att-1",
    url: "https://cdn.discordapp.com/attachments/1/2/shot.png",
    mediaType: "image/png",
    filename: "shot.png",
    byteSize: PNG.byteLength,
    ...overrides,
  };
}

function respond(body: Buffer, headers: Record<string, string>): Response {
  return new Response(new Uint8Array(body), { status: 200, headers });
}

describe("resolving a Discord attachment into bytes", () => {
  it("returns a data URL the model can read", async () => {
    const seen: Array<{ url: string; redirect?: string }> = [];
    const resolved = await fetchDiscordAttachment(attachment(), {
      fetchImpl: (input, init) => {
        seen.push({
          url: String(input),
          ...(init?.redirect === undefined ? {} : { redirect: init.redirect }),
        });
        return Promise.resolve(
          respond(PNG, { "content-type": "image/png", "content-length": String(PNG.byteLength) }),
        );
      },
    });

    expect(resolved).toEqual({
      id: "att-1",
      mediaType: "image/png",
      filename: "shot.png",
      dataUrl: `data:image/png;base64,${PNG.toString("base64")}`,
    });
    // A redirect is how an allowlisted host becomes a non-allowlisted one.
    expect(seen[0]?.redirect).toBe("error");
  });

  it("accepts Discord's image proxy for GIF-picker previews", async () => {
    await expect(
      fetchDiscordAttachment(
        attachment({
          url: "https://images-ext-1.discordapp.net/external/greeting.webp",
          mediaType: "image/webp",
        }),
        {
          fetchImpl: () =>
            Promise.resolve(respond(PNG, { "content-type": "image/webp", "content-length": "8" })),
        },
      ),
    ).resolves.toMatchObject({ mediaType: "image/webp" });
  });

  it("expands a GIF-picker video into chronological image frames", async () => {
    const motion = Buffer.from("bounded-mp4");
    const first = Buffer.from("frame-one");
    const second = Buffer.from("frame-two");
    const resolve = createDiscordAttachmentResolver({
      fetchImpl: () =>
        Promise.resolve(
          respond(motion, { "content-type": "video/mp4", "content-length": String(motion.byteLength) }),
        ),
      extractMotionFrames: (bytes, count) => {
        expect(bytes).toEqual(motion);
        expect(count).toBe(4);
        return Promise.resolve([first, second]);
      },
    });

    await expect(
      resolve([
        attachment({
          url: "https://images-ext-1.discordapp.net/external/greeting.webp",
          motionUrl: "https://images-ext-1.discordapp.net/external/greeting.mp4",
          mediaType: "image/webp",
        }),
      ]),
    ).resolves.toEqual([
      {
        id: "att-1",
        mediaType: "image/png",
        frameIndex: 1,
        frameCount: 2,
        dataUrl: `data:image/png;base64,${first.toString("base64")}`,
      },
      {
        id: "att-1",
        mediaType: "image/png",
        frameIndex: 2,
        frameCount: 2,
        dataUrl: `data:image/png;base64,${second.toString("base64")}`,
      },
    ]);
  });

  it("refuses any host outside Discord's CDN", async () => {
    const calls: string[] = [];
    const fetchImpl = (input: URL | RequestInfo) => {
      calls.push(String(input));
      return Promise.resolve(respond(PNG, { "content-type": "image/png" }));
    };

    for (const url of [
      "https://evil.example.com/shot.png",
      "https://cdn.discordapp.com.evil.example.com/shot.png",
      "https://images-ext-1.discordapp.net.evil.example.com/shot.png",
      "http://169.254.169.254/latest/meta-data/",
      "http://cdn.discordapp.com/shot.png",
    ]) {
      await expect(fetchDiscordAttachment(attachment({ url }), { fetchImpl })).rejects.toThrow(
        /discord_attachment_(host_not_allowlisted|scheme_unsupported)/u,
      );
    }
    // Refused before the request, so an attacker-chosen URL is never even dialled.
    expect(calls).toEqual([]);
  });

  it("refuses what the CDN actually serves when it is not an image he can read", async () => {
    await expect(
      fetchDiscordAttachment(attachment(), {
        fetchImpl: () =>
          Promise.resolve(respond(Buffer.from("%PDF-1.7"), { "content-type": "application/pdf" })),
      }),
    ).rejects.toThrow("discord_attachment_media_type_unsupported");
  });

  it("enforces the size ceiling on a lying header and on the bytes themselves", async () => {
    await expect(
      fetchDiscordAttachment(attachment(), {
        fetchImpl: () =>
          Promise.resolve(
            respond(PNG, {
              "content-type": "image/png",
              "content-length": String(DISCORD_PRESENCE_ATTACHMENT_BYTES_MAX + 1),
            }),
          ),
      }),
    ).rejects.toThrow("discord_attachment_too_large");

    // No content-length at all, and a body past the ceiling: the header is not
    // allowed to be the only thing standing between the CDN and memory.
    await expect(
      fetchDiscordAttachment(attachment(), {
        fetchImpl: () =>
          Promise.resolve(
            respond(Buffer.alloc(DISCORD_PRESENCE_ATTACHMENT_BYTES_MAX + 1), {
              "content-type": "image/png",
            }),
          ),
      }),
    ).rejects.toThrow("discord_attachment_too_large");
  });

  it("keeps the images it could read when a sibling fails", async () => {
    const resolve = createDiscordAttachmentResolver({
      fetchImpl: (input) =>
        String(input).includes("broken")
          ? Promise.resolve(new Response("nope", { status: 404 }))
          : Promise.resolve(respond(PNG, { "content-type": "image/png" })),
    });

    const resolved = await resolve([
      attachment({ id: "ok-1" }),
      attachment({ id: "broken", url: "https://cdn.discordapp.com/attachments/1/2/broken.png" }),
      attachment({ id: "ok-2" }),
    ]);

    // Only what it holds bytes for — a partial result must never read as complete.
    expect(resolved.map((entry) => entry.id)).toEqual(["ok-1", "ok-2"]);
  });

  it("gives up on a hung CDN rather than holding the turn open", async () => {
    const resolve = createDiscordAttachmentResolver({
      timeoutMs: 5,
      fetchImpl: (_input, init) =>
        new Promise((_resolveFetch, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    });

    await expect(resolve([attachment()])).resolves.toEqual([]);
  });
});
