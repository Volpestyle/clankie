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
