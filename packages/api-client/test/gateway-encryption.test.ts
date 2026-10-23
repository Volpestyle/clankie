import { describe, expect, it, vi } from "vitest";
import {
  base64,
  createGatewayEncryptedFetch,
  createWebGatewayCrypto,
  GatewayRequestError,
  unbase64,
} from "../src/gateway-encryption.ts";
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

describe("base64 on the wire (VUH-2700)", () => {
  const web = createWebGatewayCrypto();
  const key = Buffer.alloc(32, 7).toString("base64");
  const aad = "aad";

  it("round-trips every padding length and a body of many chunks", async () => {
    // Sealed is 12 + n + 16 bytes, so n = 0, 1, 2 covers all three padding shapes.
    for (const plaintext of ["", "a", "ab", "abc", "é", "x".repeat(600_000) + "ü"]) {
      const sealed = await web.seal(key, plaintext, aad);
      expect(sealed).toBe(Buffer.from(sealed, "base64").toString("base64"));
      await expect(web.open(key, sealed, aad)).resolves.toBe(plaintext);
    }
  });

  it("refuses anything but the exact text base64 writes", async () => {
    const twoPad = await web.seal(key, "", aad); // 28 bytes: ends "=="
    const onePad = await web.seal(key, "a", aad); // 29 bytes: ends "="
    expect(twoPad.endsWith("==")).toBe(true);
    expect(onePad.endsWith("=") && !onePad.endsWith("==")).toBe(true);
    // The same bytes with nonzero trailing bits before the padding.
    const bump = (text: string, at: number) => {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      return text.slice(0, at) + alphabet[alphabet.indexOf(text[at]!) ^ 1] + text.slice(at + 1);
    };
    const variants = [
      bump(twoPad, twoPad.length - 3),
      bump(onePad, onePad.length - 2),
      twoPad.slice(0, -2),
      onePad.slice(0, -1),
      `${twoPad.slice(0, 8)}\n${twoPad.slice(8)}`,
      ` ${onePad}`,
      // A URL-safe '-' is never canonical base64: at a + or / when the random ciphertext has one,
      // else in place of its first character, so the variant can never equal the canonical text.
      /[+/]/u.test(onePad) ? onePad.replace(/[+/]/u, "-") : `-${onePad.slice(1)}`,
      `${onePad}=`,
    ];
    for (const sealed of variants) {
      expect(Buffer.from(sealed, "base64").toString("base64")).not.toBe(sealed);
      await expect(web.open(key, sealed, aad)).rejects.toThrow(
        /Noncanonical encrypted data|Invalid character|not correctly encoded/u,
      );
    }
  });
});

describe("base64 matches the original per-byte version (VUH-2700)", () => {
  // The implementation before VUH-2700, kept here as the reference.
  const oldBase64 = (bytes: Uint8Array) => {
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  };
  const oldUnbase64 = (text: string) => {
    const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    if (oldBase64(bytes) !== text) throw new Error("Noncanonical encrypted data");
    return bytes;
  };
  const outcome = (decode: (text: string) => Uint8Array, text: string) => {
    try {
      return Array.from(decode(text)).join(",");
    } catch {
      return "refused";
    }
  };
  // A small seeded generator, so a failure names a reproducible case.
  let seed = 0x2700;
  const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
  const randomBytes = (length: number) => Uint8Array.from({ length }, () => next() & 0xff);
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=-_ \n";

  it("encodes every length the same, across the chunk boundary", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 8191, 8192, 8193, 16_385, 100_000]) {
      const bytes = randomBytes(length);
      expect(base64(bytes)).toBe(oldBase64(bytes));
      expect(Array.from(unbase64(oldBase64(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it("encodes random bytes exactly as before", () => {
    for (let round = 0; round < 500; round++) {
      const bytes = randomBytes(next() % 70);
      expect(base64(bytes)).toBe(oldBase64(bytes));
    }
    const big = randomBytes(300_001);
    expect(base64(big)).toBe(oldBase64(big));
  });

  it("accepts and refuses exactly the same texts, decoding the same bytes", () => {
    for (let round = 0; round < 5000; round++) {
      let text = oldBase64(randomBytes(next() % 12));
      // Leave some untouched; mutate the rest by replacing, inserting or dropping a character.
      for (let edits = next() % 3; edits > 0; edits--) {
        const at = next() % (text.length + 1);
        const character = characters[next() % characters.length]!;
        const kind = next() % 3;
        text =
          kind === 0
            ? text.slice(0, at) + character + text.slice(at + 1)
            : kind === 1
              ? text.slice(0, at) + character + text.slice(at)
              : text.slice(0, at) + text.slice(at + 1);
      }
      expect(outcome(unbase64, text), JSON.stringify(text)).toBe(outcome(oldUnbase64, text));
    }
  });
});
