import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { PUBLIC_GATEWAY_PUSH_REGISTRATIONS_PATH } from "@clankie/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { clientAddress, normalizeAddress, trustedProxyByName } from "../src/client-address.ts";
import type { ApnsSender } from "../src/apns.ts";
import { createPublicGateway } from "../src/gateway.ts";
import type { PushRegistrations } from "../src/push-registrations.ts";

const request = (peer: string, forwarded?: string | string[]) =>
  ({
    socket: { remoteAddress: peer },
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
  }) as unknown as IncomingMessage;

describe("client address", () => {
  const caddy = trustedProxyByName("172.18.0.3");

  it("takes the last X-Forwarded-For entry only from the trusted proxy", () => {
    expect(clientAddress(request("172.18.0.3", "203.0.113.7"), caddy)).toBe("203.0.113.7");
    expect(clientAddress(request("::ffff:172.18.0.3", "203.0.113.7"), caddy)).toBe("203.0.113.7");
    // A client-sent entry comes first; the proxy's own entry is last.
    expect(clientAddress(request("172.18.0.3", "10.0.0.1, 203.0.113.7"), caddy)).toBe("203.0.113.7");
    expect(clientAddress(request("172.18.0.3", ["10.0.0.1", "203.0.113.7"]), caddy)).toBe("203.0.113.7");
  });

  it("ignores a forwarded header from anyone else, and a malformed one from the proxy", () => {
    expect(clientAddress(request("198.51.100.9", "203.0.113.7"), caddy)).toBe("198.51.100.9");
    expect(clientAddress(request("172.18.0.3", "203.0.113.7, not-an-ip"), caddy)).toBe("172.18.0.3");
    expect(clientAddress(request("172.18.0.3"), caddy)).toBe("172.18.0.3");
    // Without a configured proxy nothing is trusted.
    expect(clientAddress(request("172.18.0.3", "203.0.113.7"))).toBe("172.18.0.3");
    expect(normalizeAddress("::FFFF:10.0.0.1")).toBe("10.0.0.1");
  });

  it("resolves a proxy name, follows it when it moves, and keeps the last answer on failure", async () => {
    let answer: string[] | Error = ["172.18.0.3"];
    const proxy = trustedProxyByName("clankie-caddy", async () => {
      if (answer instanceof Error) throw answer;
      return answer.map((address) => ({ address }));
    });
    expect(proxy.trusts("172.18.0.3")).toBe(false);
    await proxy.refresh();
    expect(proxy.trusts("172.18.0.3")).toBe(true);
    answer = ["172.18.0.9"];
    await proxy.refresh();
    expect([proxy.trusts("172.18.0.3"), proxy.trusts("172.18.0.9")]).toEqual([false, true]);
    answer = new Error("ENOTFOUND");
    await proxy.refresh();
    expect(proxy.trusts("172.18.0.9")).toBe(true);
  });
});

describe("per-client peer budgets behind the proxy", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function start(proxy: string) {
    // Push registration is the unauthenticated route budgeted per client before
    // its body is read; with an unusable body it answers 400 without a lookup.
    const gateway = createPublicGateway({
      hostTokens: new Map(),
      trustedProxy: trustedProxyByName(proxy),
      clock: () => 1_800_000_000_000,
      push: { registrations: {} as PushRegistrations, sender: {} as ApnsSender },
    });
    closers.push(() => gateway.close());
    gateway.server.listen(0, "127.0.0.1");
    await once(gateway.server, "listening");
    const origin = `http://127.0.0.1:${String((gateway.server.address() as AddressInfo).port)}`;
    // A malformed registration spends one peer token, then answers 400.
    const offer = async (forwarded: string) =>
      (
        await fetch(`${origin}${PUBLIC_GATEWAY_PUSH_REGISTRATIONS_PATH}`, {
          method: "POST",
          headers: { "x-forwarded-for": forwarded },
          body: "{}",
        })
      ).status;
    return { offer };
  }

  it("gives each client its own bucket, so one client cannot block registration for everyone", async () => {
    const { offer } = await start("127.0.0.1");
    const first: number[] = [];
    for (let index = 0; index < 31; index += 1) first.push(await offer("203.0.113.1"));
    expect(first.filter((status) => status === 400)).toHaveLength(30);
    expect(first.at(-1)).toBe(429);
    expect(await offer("203.0.113.2")).toBe(400);
    // Prepending a made-up address does not escape: the proxy's entry is last.
    expect(await offer("198.51.100.77, 203.0.113.1")).toBe(429);
  });

  it("ignores X-Forwarded-For from a peer that is not the proxy", async () => {
    const { offer } = await start("10.9.9.9");
    const statuses: number[] = [];
    for (let index = 0; index < 31; index += 1) statuses.push(await offer(`203.0.113.${String(index + 1)}`));
    // Every request is the socket peer's, whatever it claims.
    expect(statuses.filter((status) => status === 400)).toHaveLength(30);
    expect(statuses.at(-1)).toBe(429);
  });
});
