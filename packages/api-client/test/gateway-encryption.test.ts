import { describe, expect, it, vi } from "vitest";
import { createGatewayEncryptedFetch, GatewayRequestError } from "../src/gateway-encryption.ts";

const credential = { hostId: "a".repeat(16), key: "A".repeat(43) + "=", ticket: "A".repeat(40) };
const crypto = {
  randomBytes: (length: number) => new Uint8Array(length),
  seal: async () => "sealed",
  open: async () => "",
};

describe("gateway transport refusals", () => {
  it.each([401, 403, 502, 503])(
    "preserves challenge HTTP %i and never sends the application request",
    async (status) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
      const send = createGatewayEncryptedFetch({ credential: () => credential, crypto, fetchImpl });
      await expect(
        send(`https://example.test/h/${credential.hostId}/v1/messages`, { method: "POST", body: "hello" }),
      ).rejects.toMatchObject({
        name: "GatewayRequestError",
        status,
        message: "Gateway challenge unavailable",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each([401, 403, 502, 503])(
    "preserves encrypted-request HTTP %i without replaying an uncertain send",
    async (status) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ version: 1, challenge: "a".repeat(64) }))
        .mockResolvedValueOnce(new Response(null, { status }));
      const send = createGatewayEncryptedFetch({ credential: () => credential, crypto, fetchImpl });
      const failed = send(`https://example.test/h/${credential.hostId}/v1/messages`, {
        method: "POST",
        body: "hello",
      });
      await expect(failed).rejects.toBeInstanceOf(GatewayRequestError);
      await expect(failed).rejects.toMatchObject({
        status,
        message: `Encrypted gateway request refused (${status}); re-pair if the host key changed`,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );
});

describe("encrypted Discord directory queries", () => {
  it.each([
    "kind=servers&limit=200",
    "kind=channels&guildId=12345&after=67890&limit=200",
    "kind=roles&guildId=12345",
  ])("admits a valid read (%s)", async (query) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    const send = createGatewayEncryptedFetch({ credential: () => credential, crypto, fetchImpl });
    await expect(
      send(`https://example.test/h/${credential.hostId}/v1/discord/directory?${query}`),
    ).rejects.toBeInstanceOf(GatewayRequestError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([
    "kind=roles",
    "kind=servers&limit=201",
    "kind=servers&kind=servers",
    "kind=%73ervers",
    "kind=servers&unknown=true",
  ])("refuses an invalid query before transport (%s)", async (query) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const send = createGatewayEncryptedFetch({ credential: () => credential, crypto, fetchImpl });
    await expect(
      send(`https://example.test/h/${credential.hostId}/v1/discord/directory?${query}`),
    ).rejects.toThrow("Gateway host identity mismatch");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("does not allow a query on writes", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const send = createGatewayEncryptedFetch({ credential: () => credential, crypto, fetchImpl });
    await expect(
      send(`https://example.test/h/${credential.hostId}/v1/discord/directory?kind=servers`, {
        method: "POST",
      }),
    ).rejects.toThrow("Gateway host identity mismatch");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
