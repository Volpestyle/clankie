import { generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DeviceWakeKeyRequestSchema,
  DeviceWakeKeyResponseSchema,
  WakeChallengeResponseSchema,
  WakeErrorCodeSchema,
  WakeRequestSchema,
  WakeResponseSchema,
  wakeSigningInput,
} from "../src/wake.ts";

const hostId = "h_0123456789abcdef";
const deviceId = "dev_0123456789";
const challenge = `1790000000000.${"A".repeat(22)}.${"b".repeat(43)}`;

describe("wake contract", () => {
  it("carries a real P-256 x963 public key and raw r‖s signature at their exact widths", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const point = publicKey.export({ format: "jwk" });
    const x963 = Buffer.concat([
      Buffer.from([4]),
      Buffer.from(point.x ?? "", "base64url"),
      Buffer.from(point.y ?? "", "base64url"),
    ]);
    expect(
      DeviceWakeKeyRequestSchema.parse({ publicKey: x963.toString("base64url") }).publicKey,
    ).toHaveLength(87);

    const input = Buffer.from(wakeSigningInput(hostId, deviceId, challenge), "utf8");
    const signature = sign("sha256", input, { key: privateKey, dsaEncoding: "ieee-p1363" });
    const request = WakeRequestSchema.parse({
      deviceId,
      challenge,
      signature: signature.toString("base64url"),
    });
    expect(
      verify(
        "sha256",
        input,
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(request.signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("binds domain, host, device and challenge on separate lines", () => {
    expect(wakeSigningInput(hostId, deviceId, challenge)).toBe(
      `clankie-wake-v1\n${hostId}\n${deviceId}\n${challenge}`,
    );
  });

  it("refuses padded, DER-sized or extra-field bodies", () => {
    expect(WakeRequestSchema.safeParse({ deviceId, challenge, signature: "A".repeat(94) }).success).toBe(
      false,
    );
    expect(
      WakeRequestSchema.safeParse({ deviceId, challenge, signature: `${"A".repeat(84)}==` }).success,
    ).toBe(false);
    expect(
      WakeRequestSchema.safeParse({ deviceId, challenge, signature: "A".repeat(86), token: "x" }).success,
    ).toBe(false);
    expect(DeviceWakeKeyRequestSchema.safeParse({ publicKey: "A".repeat(88) }).success).toBe(false);
    expect(DeviceWakeKeyResponseSchema.safeParse({ deviceId: "short" }).success).toBe(false);
    expect(DeviceWakeKeyResponseSchema.safeParse({ deviceId: "has space in it" }).success).toBe(false);
  });

  it("parses the fleet's challenge and answers", () => {
    expect(WakeChallengeResponseSchema.parse({ challenge, expiresAtMs: 1790000000000 }).challenge).toBe(
      challenge,
    );
    expect(WakeChallengeResponseSchema.safeParse({ challenge: "1.2.3", expiresAtMs: 1 }).success).toBe(false);
    expect(WakeResponseSchema.parse({ state: "waking", retryAfterMs: 5000 })).toEqual({
      state: "waking",
      retryAfterMs: 5000,
    });
    expect(WakeResponseSchema.safeParse({ state: "asleep", retryAfterMs: 5000 }).success).toBe(false);
    const wakeId = `wk_${"A".repeat(22)}`;
    expect(WakeResponseSchema.parse({ state: "waking", retryAfterMs: 5000, wakeId }).wakeId).toBe(wakeId);
    expect(
      WakeResponseSchema.safeParse({ state: "waking", retryAfterMs: 5000, wakeId: "wk_short" }).success,
    ).toBe(false);
    expect(WakeResponseSchema.safeParse({ state: "running", retryAfterMs: 0 }).success).toBe(false);
    expect(WakeErrorCodeSchema.options).toContain("budget_egress_allowance");
    expect(WakeErrorCodeSchema.safeParse("host_unavailable").success).toBe(false);
  });
});
