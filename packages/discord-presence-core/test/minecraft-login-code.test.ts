import { expect, it, vi } from "vitest";
import { createMinecraftLoginCodeDelivery } from "../src/minecraft-login-code.ts";
const input = {
  capability: "a".repeat(64),
  operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  recipientId: "123",
  username: "Friend",
  providerId: "minecraft_friend_friend",
};
it.each(["bot", "user_session"] as const)(
  "privately relays through %s with final guard and safe result",
  async (transport) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      return String(url).endsWith("/authorize")
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ id: "456" }));
    }) as unknown as typeof fetch;
    const deliver = createMinecraftLoginCodeDelivery({
      apiUrl: "http://127.0.0.1:4310",
      bridgeToken: "bridge",
      discordToken: "body",
      transport,
      getCredential: async () => ({ type: "api", key: "secret_code_123456" }),
      fetch: fetcher,
    });
    expect(await deliver(input)).toEqual({ outcome: "delivered" });
    expect(calls.filter((call) => call.url.endsWith("/authorize"))).toHaveLength(3);
    expect(calls.at(-1)?.init?.body).toContain("/login secret_code_123456");
    expect(calls.at(-1)?.init?.headers).toMatchObject({
      authorization: transport === "bot" ? "Bot body" : "body",
    });
    expect(await deliver(input)).toEqual({ outcome: "refused" });
  },
);
it("refuses revoked authority after DM creation without secret-bearing send", async () => {
  let guards = 0;
  let sends = 0;
  const deliver = createMinecraftLoginCodeDelivery({
    apiUrl: "http://127.0.0.1:4310",
    bridgeToken: "bridge",
    discordToken: "body",
    transport: "bot",
    getCredential: async () => ({ type: "api", key: "secret_code_123456" }),
    fetch: async (url) => {
      if (String(url).endsWith("/authorize"))
        return new Response(null, { status: ++guards === 3 ? 403 : 204 });
      if (String(url).endsWith("/messages")) sends++;
      return new Response(JSON.stringify({ id: "456" }));
    },
  });
  expect(await deliver(input)).toEqual({ outcome: "refused" });
  expect(sends).toBe(0);
});
it("rejects invented provider and arbitrary extra payload", async () => {
  const getCredential = vi.fn();
  const fetcher = vi.fn();
  const deliver = createMinecraftLoginCodeDelivery({
    apiUrl: "http://127.0.0.1:4310",
    bridgeToken: "bridge",
    discordToken: "body",
    transport: "bot",
    getCredential,
    fetch: fetcher,
  });
  expect(await deliver({ ...input, providerId: "minecraft_friend_other" })).toEqual({ outcome: "refused" });
  expect(await deliver({ ...input, code: "leak" })).toEqual({ outcome: "refused" });
  expect(getCredential).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
it("marks timeout after secret-bearing dispatch uncertain without leaking error", async () => {
  const deliver = createMinecraftLoginCodeDelivery({
    apiUrl: "http://127.0.0.1:4310",
    bridgeToken: "bridge",
    discordToken: "body",
    transport: "bot",
    getCredential: async () => ({ type: "api", key: "secret_code_123456" }),
    fetch: async (url) => {
      if (String(url).endsWith("/authorize")) return new Response(null, { status: 204 });
      if (String(url).endsWith("/messages")) throw new Error("secret_code_123456");
      return new Response(JSON.stringify({ id: "456" }));
    },
  });
  expect(await deliver(input)).toEqual({ outcome: "uncertain" });
});
