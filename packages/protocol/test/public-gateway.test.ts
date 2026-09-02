import { describe, expect, it } from "vitest";
import { PairingRedeemResponseSchema } from "../src/index.ts";
import {
  PUBLIC_GATEWAY_REQUEST_BODY_BYTES_MAX,
  PUBLIC_GATEWAY_RESPONSE_CHUNK_BYTES_MAX,
  PublicGatewayConfigSchema,
  PublicGatewayInstallationIdSchema,
  PublicGatewayPairingRouteFrameSchema,
  PublicGatewayRequestFrameSchema,
  PublicGatewayResponseChunkFrameSchema,
  PublicGatewayTunnelFrameSchema,
  publicGatewayTargetFor,
} from "../src/public-gateway.ts";

const requestId = "request_12345678";

describe("public gateway protocol", () => {
  it("publishes only bounded non-secret account discovery", () => {
    const config = {
      schemaVersion: 1,
      account: {
        provider: "cognito_email_otp",
        endpoint: "https://cognito-idp.us-east-1.amazonaws.com",
        issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example",
        clientId: "client123",
        selfSignUpEnabled: false,
      },
    } as const;
    expect(PublicGatewayConfigSchema.parse(config).account.provider).toBe("cognito_email_otp");
    expect(PublicGatewayInstallationIdSchema.parse("a".repeat(22))).toHaveLength(22);
    expect(() => PublicGatewayInstallationIdSchema.parse("too-short")).toThrow();
    expect(() =>
      PublicGatewayConfigSchema.parse({
        ...config,
        account: { ...config.account, issuer: `${config.account.issuer}?wrong=true` },
      }),
    ).toThrow();
  });

  it("acknowledges that a pairing route is installed", () => {
    expect(
      PublicGatewayTunnelFrameSchema.parse({
        schemaVersion: 1,
        kind: "pairing_route_ready",
        offerHash: "a".repeat(64),
      }),
    ).toMatchObject({ kind: "pairing_route_ready" });
  });

  it("keeps one shared allowlist for cloud and Mac routing", () => {
    expect(publicGatewayTargetFor("POST", "/v1/pairing/complete")).toBe("control");
    expect(publicGatewayTargetFor("POST", "/operator/v1/terminal-tail")).toBe("relay");
    expect(publicGatewayTargetFor("GET", "/v1/private")).toBeUndefined();
  });

  it("carries the host-scoped base without accepting credential-bearing URLs", () => {
    expect(
      PairingRedeemResponseSchema.parse({
        deviceId: "device-1",
        host: { name: "James Mac" },
        hostBaseUrl: "https://api.clankie.bot/h/mac_james_12345678",
        offeredGrants: { chat: true, steer: true, terminalObserve: true, terminalControl: true },
        completionToken: "completion-token",
        expiresAt: "2026-08-31T22:00:00.000Z",
      }).hostBaseUrl,
    ).toBe("https://api.clankie.bot/h/mac_james_12345678");
    expect(() =>
      PairingRedeemResponseSchema.parse({
        deviceId: "device-1",
        host: { name: "James Mac" },
        hostBaseUrl: "https://device:secret@api.clankie.bot/h/mac_james_12345678",
        offeredGrants: { chat: true, steer: true, terminalObserve: true, terminalControl: true },
        completionToken: "completion-token",
        expiresAt: "2026-08-31T22:00:00.000Z",
      }),
    ).toThrow();
    for (const hostBaseUrl of ["https://api.clankie.bot/h/mac?", "https://api.clankie.bot/h/mac#"]) {
      expect(() =>
        PairingRedeemResponseSchema.parse({
          deviceId: "device-1",
          host: { name: "James Mac" },
          hostBaseUrl,
          offeredGrants: { chat: true, steer: true, terminalObserve: true, terminalControl: true },
          completionToken: "completion-token",
          expiresAt: "2026-08-31T22:00:00.000Z",
        }),
      ).toThrow();
    }
  });

  it("parses the complete bounded exchange frame family", () => {
    const frames = [
      {
        schemaVersion: 1,
        kind: "pairing_route",
        offerHash: "a".repeat(64),
        codeHash: "b".repeat(64),
        expiresAt: "2026-08-31T22:00:00.000Z",
      },
      {
        schemaVersion: 1,
        kind: "request",
        requestId,
        target: "relay",
        method: "POST",
        path: "/operator/v1/dispatch",
        headers: [{ name: "authorization", value: "Bearer device-token" }],
        bodyBase64: Buffer.from('{"op":"list"}').toString("base64"),
      },
      {
        schemaVersion: 1,
        kind: "response_start",
        requestId,
        status: 200,
        headers: [{ name: "content-type", value: "application/json" }],
      },
      {
        schemaVersion: 1,
        kind: "response_chunk",
        requestId,
        sequence: 0,
        bodyBase64: Buffer.from("{}").toString("base64"),
      },
      { schemaVersion: 1, kind: "response_end", requestId },
      { schemaVersion: 1, kind: "cancel", requestId, reason: "client_closed" },
    ];

    expect(frames.map((frame) => PublicGatewayTunnelFrameSchema.parse(frame).kind)).toEqual([
      "pairing_route",
      "request",
      "response_start",
      "response_chunk",
      "response_end",
      "cancel",
    ]);
  });

  it("rejects raw capabilities, unknown fields, unsafe paths, and non-canonical bodies", () => {
    expect(() =>
      PublicGatewayPairingRouteFrameSchema.parse({
        schemaVersion: 1,
        kind: "pairing_route",
        offerHash: "a".repeat(64),
        codeHash: "b".repeat(64),
        offerSecret: "must-not-cross",
        expiresAt: "2026-08-31T22:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      PublicGatewayRequestFrameSchema.parse({
        schemaVersion: 1,
        kind: "request",
        requestId,
        target: "control",
        method: "POST",
        path: "//attacker.example/v1/pairing/redeem",
        headers: [],
      }),
    ).toThrow();
    expect(() =>
      PublicGatewayRequestFrameSchema.parse({
        schemaVersion: 1,
        kind: "request",
        requestId,
        target: "control",
        method: "POST",
        path: "/v1/pairing/redeem",
        headers: [],
        bodyBase64: "not base64",
      }),
    ).toThrow();
  });

  it("enforces the request and streaming chunk ceilings", () => {
    const request = {
      schemaVersion: 1,
      kind: "request",
      requestId,
      target: "relay",
      method: "POST",
      path: "/operator/v1/dispatch",
      headers: [],
    } as const;
    expect(
      PublicGatewayRequestFrameSchema.parse({
        ...request,
        bodyBase64: Buffer.alloc(PUBLIC_GATEWAY_REQUEST_BODY_BYTES_MAX).toString("base64"),
      }).bodyBase64,
    ).toBeDefined();
    expect(() =>
      PublicGatewayRequestFrameSchema.parse({
        ...request,
        bodyBase64: Buffer.alloc(PUBLIC_GATEWAY_REQUEST_BODY_BYTES_MAX + 1).toString("base64"),
      }),
    ).toThrow();

    expect(
      PublicGatewayResponseChunkFrameSchema.parse({
        schemaVersion: 1,
        kind: "response_chunk",
        requestId,
        sequence: 0,
        bodyBase64: Buffer.alloc(PUBLIC_GATEWAY_RESPONSE_CHUNK_BYTES_MAX).toString("base64"),
      }).sequence,
    ).toBe(0);
    expect(() =>
      PublicGatewayResponseChunkFrameSchema.parse({
        schemaVersion: 1,
        kind: "response_chunk",
        requestId,
        sequence: 0,
        bodyBase64: Buffer.alloc(PUBLIC_GATEWAY_RESPONSE_CHUNK_BYTES_MAX + 1).toString("base64"),
      }),
    ).toThrow();
  });
});
