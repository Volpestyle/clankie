import { describe, expect, it, vi } from "vitest";
import { createGatewayEncryptedFetch, GatewayRequestError } from "../src/gateway-encryption.ts";
import { FLEET_ROSTER_WORK_PATH } from "@clankie/protocol/fleet-roster";

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

describe("encrypted roster work projection", () => {
  it("forwards the exact opt-in query and returns enriched roster fields", async () => {
    const roster = {
      agents: [
        {
          ownership: "hired",
          project: { id: "app", name: "Clankie app" },
          task: { issue: "VUH-2472", title: "Hearth roster" },
        },
      ],
    };
    const frames =
      [
        { kind: "start", status: 200, headers: [{ name: "content-type", value: "application/json" }] },
        { kind: "chunk", bodyBase64: Buffer.from(JSON.stringify(roster)).toString("base64") },
        { kind: "end" },
      ]
        .map((frame) => JSON.stringify({ sealed: JSON.stringify(frame) }))
        .join("\n") + "\n";
    const seal = vi.fn(async (_key: string, _plain: string) => "sealed");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ version: 1, challenge: "a".repeat(64) }))
      .mockResolvedValueOnce(new Response(frames));
    const send = createGatewayEncryptedFetch({
      credential: () => credential,
      crypto: { ...crypto, seal, open: async (_key, sealed) => sealed },
      fetchImpl,
    });
    const response = await send(`https://example.test/h/${credential.hostId}${FLEET_ROSTER_WORK_PATH}`);
    expect(await response.json()).toEqual(roster);
    expect(JSON.parse(seal.mock.calls[0]![1])).toMatchObject({ method: "GET", path: FLEET_ROSTER_WORK_PATH });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    "/v1/fleet/roster?includeWork=false",
    "/v1/fleet/roster?includeWork=true&includeWork=true",
    "/v1/fleet/roster?include%57ork=true",
    "/v1/fleet/roster?includeWork=%74rue",
    "/v1/fleet/roster?includeWork=true&extra=1",
    "/v1/fleet/roster/retire?includeWork=true",
  ])("refuses other query spellings before transport (%s)", async (path) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const send = createGatewayEncryptedFetch({ credential: () => credential, crypto, fetchImpl });
    await expect(send(`https://example.test/h/${credential.hostId}${path}`)).rejects.toThrow(
      "Gateway host identity mismatch",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["POST", "DELETE"])("refuses the projection query on %s before transport", async (method) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const send = createGatewayEncryptedFetch({ credential: () => credential, crypto, fetchImpl });
    await expect(
      send(`https://example.test/h/${credential.hostId}${FLEET_ROSTER_WORK_PATH}`, { method }),
    ).rejects.toThrow("Gateway host identity mismatch");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
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

describe("encrypted Settings projections", () => {
  it.each([
    ["GET", "/v1/operator/fleet-settings/hire?includeModels=true"],
    ["GET", "/v1/operator/fleet-settings?includeWorkPolicy=true&includeMaximumTrust=true"],
    ["POST", "/v1/operator/fleet-settings?includeWorkPolicy=true&includeMaximumTrust=true"],
  ])("admits the explicit %s projection %s", async (method, path) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    const send = createGatewayEncryptedFetch({ credential: () => credential, crypto, fetchImpl });
    await expect(send(`https://example.test/h/${credential.hostId}${path}`, { method })).rejects.toThrow(
      "Gateway challenge unavailable",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["POST", "/v1/operator/fleet-settings/hire?includeModels=true"],
    ["GET", "/v1/operator/fleet-settings/hire?includeModels=true&unknown=true"],
    ["GET", "/v1/operator/fleet-settings?includeMaximumTrust=true&includeMaximumTrust=true"],
    ["GET", "/v1/operator/fleet-settings?includeMaximumTrust=%74rue"],
  ])("rejects unsupported %s projection %s before transport", async (method, path) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const send = createGatewayEncryptedFetch({ credential: () => credential, crypto, fetchImpl });
    await expect(send(`https://example.test/h/${credential.hostId}${path}`, { method })).rejects.toThrow(
      "Gateway host identity mismatch",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
