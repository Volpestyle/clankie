import { describe, expect, it } from "vitest";
import {
  DevicePushRequestSchema,
  PublicGatewayPushClearRequestSchema,
  PublicGatewayPushRegistrationRequestSchema,
  PublicGatewayPushWakeFrameSchema,
} from "../src/index.ts";
import { PublicGatewayTunnelFrameSchema, publicGatewayTargetFor } from "../src/public-gateway.ts";

const binding = { registrationId: "06480edf-46e9-4f42-a741-d009a7ad684a", sequence: 1 };
const wake = {
  ...binding,
  schemaVersion: 1,
  kind: "push_wake",
  wakeId: "f3dd4c2c-dfdf-49f6-8d75-3780277e2134",
  deviceId: "device-1",
  conversationId: "conv-1",
};

describe("device push boundary", () => {
  it("routes device references and rejects token, secret or content fields on host frames", () => {
    expect(PublicGatewayTunnelFrameSchema.parse(wake)).toEqual(wake);
    expect(publicGatewayTargetFor("POST", "/v1/devices/self/push")).toBe("control");
    expect(DevicePushRequestSchema.parse({ ...binding, enabled: true })).toEqual({
      ...binding,
      enabled: true,
    });
    for (const key of ["deviceToken", "deliveryKey", "hostId", "title", "body", "text", "url", "topic"]) {
      expect(PublicGatewayPushWakeFrameSchema.safeParse({ ...wake, [key]: "untrusted" }).success).toBe(false);
    }
  });

  it("reserves token and delivery key for direct registration and supports host-independent clear", () => {
    const registration = {
      ...binding,
      hostId: "host-123456789012",
      deviceToken: "ab".repeat(32),
      environment: "sandbox",
      deliveryKey: "A".repeat(43),
    };
    expect(PublicGatewayPushRegistrationRequestSchema.parse(registration)).toEqual(registration);
    expect(
      PublicGatewayPushClearRequestSchema.parse({ ...binding, deliveryKey: registration.deliveryKey }),
    ).toEqual({ ...binding, deliveryKey: registration.deliveryKey });
    expect(
      PublicGatewayPushRegistrationRequestSchema.safeParse({ ...registration, deviceToken: "abc" }).success,
    ).toBe(false);
    expect(
      PublicGatewayPushRegistrationRequestSchema.safeParse({ ...registration, deliveryKey: "short" }).success,
    ).toBe(false);
  });

  it("rejects invalid revisions and unbounded identifiers", () => {
    for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(PublicGatewayPushWakeFrameSchema.safeParse({ ...wake, sequence }).success).toBe(false);
    }
    for (const conversationId of ["", "A".repeat(129), "message content", "https://example.com"]) {
      expect(PublicGatewayPushWakeFrameSchema.safeParse({ ...wake, conversationId }).success).toBe(false);
    }
  });
});
