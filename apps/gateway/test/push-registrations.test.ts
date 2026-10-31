import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PushRegistrations } from "../src/push-registrations.ts";

const roots: string[] = [];
const stores: PushRegistrations[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function store(path = ":memory:", clock = () => 1_000): PushRegistrations {
  const result = new PushRegistrations(path, clock);
  stores.push(result);
  return result;
}

const request = {
  registrationId: "06480edf-46e9-4f42-a741-d009a7ad684a",
  sequence: 1,
  hostId: "host-A",
  deviceToken: "ab".repeat(32),
  environment: "sandbox" as const,
  deliveryKey: "A".repeat(43),
};

describe("push delivery authorization", () => {
  it("bounds durable allocation per account including cleared rows and different hosts", () => {
    const registry = store();
    for (let i = 0; i < 1024; i += 1) {
      registry.clear({ ...request, registrationId: randomUUID(), sequence: 2 }, "account-1");
    }
    expect(() => registry.register(request, "device-A", "account-1")).toThrow("registration_limit");
    expect(() => registry.clear({ ...request, sequence: 2 }, "account-1")).toThrow("registration_limit");
    expect(registry.register(request, "device-A", "account-2")).toMatchObject({ sequence: 1 });
    expect(() =>
      registry.register({ ...request, hostId: "different-host", sequence: 2 }, "device-B", "account-1"),
    ).toThrow("registration_limit");
    expect(registry.delivery(request.hostId, "device-A", request)).toMatchObject({ sequence: 1 });
  });

  it("requires the app key to move the binding and preserves it across gateway restart", () => {
    const root = mkdtempSync(join(tmpdir(), "push-registrations-"));
    roots.push(root);
    const path = join(root, "push.sqlite");
    const first = store(path);
    const a = first.register(request, "device-A", "account-1");
    expect(first.delivery("host-A", "device-A", a)).toMatchObject({ deviceToken: request.deviceToken });
    expect(first.delivery("host-B", "device-A", a)).toBe("superseded");
    expect(first.delivery("host-A", "device-B", a)).toBe("superseded");
    const b = first.register({ ...request, hostId: "host-B", sequence: 2 }, "device-B", "account-1");
    expect(() =>
      first.register({ ...request, sequence: 3, deliveryKey: "B".repeat(43) }, "device-A", "account-1"),
    ).toThrow("mismatched_delivery_key");
    first.close();
    stores.splice(stores.indexOf(first), 1);
    const restored = store(path);
    expect(restored.delivery("host-A", "device-A", a)).toBe("superseded");
    expect(restored.delivery("host-B", "device-B", b)).toMatchObject({ sequence: 2 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path).includes(Buffer.from(request.deliveryKey))).toBe(false);
  });

  it("accepts exact retries, rejects conflicting/old versions and reserves a token to its registration", () => {
    const registry = store();
    expect(registry.register(request, "device-A", "account-1")).toEqual(
      registry.register(request, "device-A", "account-1"),
    );
    expect(() => registry.register({ ...request, hostId: "host-B" }, "device-B", "account-1")).toThrow(
      "stale_registration",
    );
    expect(() =>
      registry.register(
        { ...request, registrationId: "f3dd4c2c-dfdf-49f6-8d75-3780277e2134" },
        "device-B",
        "account-1",
      ),
    ).toThrow("token_already_registered");
    registry.clear({ ...request, sequence: 3 });
    expect(() => registry.register({ ...request, sequence: 2 }, "device-A", "account-1")).toThrow(
      "stale_registration",
    );
    expect(() =>
      registry.register(
        { ...request, registrationId: "f3dd4c2c-dfdf-49f6-8d75-3780277e2134" },
        "device-B",
        "account-1",
      ),
    ).toThrow("token_already_registered");
    expect(registry.delivery("host-A", "device-A", request)).toBe("not_registered");
    expect(registry.register({ ...request, sequence: 4 }, "device-A", "account-1")).toMatchObject({
      sequence: 4,
    });
  });

  it("clears existing rows offline, but authenticates allocation when clear beats first registration", () => {
    const registry = store();
    expect(() => registry.clear({ ...request, sequence: 2 })).toThrow("not_registered");
    registry.clear({ ...request, sequence: 2 }, "account-1");
    expect(() => registry.register(request, "device-A", "account-1")).toThrow("stale_registration");
    expect(registry.clear({ ...request, sequence: 2 })).toMatchObject({ sequence: 2 });
    expect(() => registry.clear({ ...request, sequence: 3, deliveryKey: "B".repeat(43) })).toThrow(
      "mismatched_delivery_key",
    );
    registry.register({ ...request, sequence: 3 }, "device-A", "account-1");
    expect(() => registry.clear({ ...request, sequence: 2 })).toThrow("stale_registration");
  });

  it("checks both the sent version and APNs timestamp before invalidating", () => {
    let now = 1_000;
    const registry = store(":memory:", () => now);
    const a = registry.register(request, "device-A", "account-1");
    const sent = registry.delivery("host-A", "device-A", a);
    if (typeof sent === "string") throw new Error("missing delivery");
    expect(registry.invalidate(sent, undefined)).toBe(false);
    expect(registry.invalidate(sent, 999)).toBe(false);
    now = 2_000;
    const b = registry.register(
      { ...request, deviceToken: "cd".repeat(32), sequence: 2 },
      "device-A",
      "account-1",
    );
    expect(registry.invalidate(sent, 3_000)).toBe(false);
    const current = registry.delivery("host-A", "device-A", b);
    if (typeof current === "string") throw new Error("new token was cleared");
    expect(registry.invalidate(current, 2_000)).toBe(true);
    expect(registry.delivery("host-A", "device-A", b)).toBe("not_registered");
  });
});
