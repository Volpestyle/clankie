import { describe, expect, it, vi } from "vitest";
import { createChannelProjection } from "../src/captain/channel-projection.ts";

const CREDENTIAL = {
  guildId: "guild-1",
  channelId: "discord-channel-1",
  webhookId: "42",
  webhookToken: "tok",
};

describe("createChannelProjectionPost", () => {
  it("posts as the member through the channel's webhook, asking for the message id back", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    await createChannelProjection({ fetch: fetchImpl as unknown as typeof fetch }).post({
      ...CREDENTIAL,
      username: "atlas",
      content: "it re-decodes per mount",
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/v10/webhooks/42/tok?wait=true");
    expect(JSON.parse(String(init.body))).toEqual({
      username: "atlas",
      content: "it re-decodes per mount",
      // An agent's words must never be able to ping a room.
      allowed_mentions: { parse: [] },
    });
  });

  it("shows a long answer short rather than not showing it", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    await createChannelProjection({ fetch: fetchImpl as unknown as typeof fetch }).post({
      ...CREDENTIAL,
      username: "a".repeat(120),
      content: "x".repeat(4_000),
    });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.content).toHaveLength(2_000);
    expect(body.content.endsWith("…")).toBe(true);
    expect(body.username).toHaveLength(80);
  });

  it("reports a refused post so the caller can treat the projection as best-effort", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("{}", { status: 401 })));
    await expect(
      createChannelProjection({ fetch: fetchImpl as unknown as typeof fetch }).post({
        ...CREDENTIAL,
        username: "atlas",
        content: "hello",
      }),
    ).rejects.toThrow("discord_webhook_post_failed_401");
  });
});

describe("createChannelProjection resolve", () => {
  const resolveWith = (body: unknown, status = 200) => {
    const fetchImpl = vi.fn((_url: string) =>
      Promise.resolve(new Response(JSON.stringify(body), { status })),
    );
    return {
      fetchImpl,
      resolve: createChannelProjection({ fetch: fetchImpl as unknown as typeof fetch }).resolve,
    };
  };

  it("asks Discord which room the webhook points at, so no ids are typed by hand", async () => {
    const { fetchImpl, resolve } = resolveWith({ guild_id: "guild-9", channel_id: "channel-9" });
    await expect(resolve({ webhookId: "42", webhookToken: "tok" })).resolves.toEqual({
      guildId: "guild-9",
      channelId: "channel-9",
    });
    // The token in the URL authenticates this, so no bot grant is involved.
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://discord.com/api/v10/webhooks/42/tok");
  });

  it("refuses a webhook that is not in a guild, which is not a room a fleet can sit in", async () => {
    const { resolve } = resolveWith({ channel_id: "channel-9" });
    await expect(resolve({ webhookId: "42", webhookToken: "tok" })).rejects.toThrow(
      "discord_webhook_not_in_a_guild",
    );
  });

  it("reports an unreachable webhook rather than saving a projection that never posts", async () => {
    const { resolve } = resolveWith({}, 404);
    await expect(resolve({ webhookId: "42", webhookToken: "tok" })).rejects.toThrow(
      "discord_webhook_unreachable_404",
    );
  });
});
