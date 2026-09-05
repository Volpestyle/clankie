import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_A, HOST_B, startWorld } from "./harness.ts";

const worlds: Array<{ stop: () => Promise<void> }> = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.stop();
});
async function world() {
  const value = await startWorld();
  worlds.push(value);
  return value;
}
/** The app's own record, read the way a restarted process would. */
function record(store: Map<string, string>) {
  const raw = store.get("clankie.device.push.v1");
  return raw === undefined
    ? null
    : (JSON.parse(raw) as {
        registrationId: string;
        sequence: number;
        desired: { op: string; sequence: number } | null;
        active: { sequence: number; hostId: string } | null;
      });
}

describe("ordinary lifecycle against the real gateway", () => {
  it("enables gateway-first, hands the host only a reference, and is deliverable", async () => {
    const w = await world();
    const host = await w.connectHost(HOST_A);
    w.setSession(HOST_A);
    const app = w.app();
    await app.enable();

    expect(app.status()).toMatchObject({ state: "on", pending: undefined });
    const state = record(w.store);
    expect(state?.active).toMatchObject({ hostId: HOST_A });
    // The gateway committed before the host was told: the row is deliverable at
    // exactly the version the host now holds.
    const delivery = w.registrations.delivery(HOST_A, "device-1", {
      registrationId: state!.registrationId,
      sequence: state!.active!.sequence,
    });
    expect(typeof delivery).not.toBe("string");
    // The host saw a device lookup (gateway's own) and the reference. Nothing else.
    expect(host.seen.map((entry) => entry.path)).toEqual(["/v1/devices/self", "/v1/devices/self/push"]);
    expect(host.seen[1]?.body).toEqual({
      registrationId: state!.registrationId,
      sequence: state!.active!.sequence,
      enabled: true,
    });
  });

  it("disables, then re-enables at a newer version", async () => {
    const w = await world();
    await w.connectHost(HOST_A);
    w.setSession(HOST_A);
    const app = w.app();
    await app.enable();
    const enabled = record(w.store)!;

    await app.disable();
    expect(app.status()).toMatchObject({ state: "off", pending: undefined });
    expect(
      w.registrations.delivery(HOST_A, "device-1", {
        registrationId: enabled.registrationId,
        sequence: enabled.active!.sequence,
      }),
    ).toBe("not_registered");

    await app.enable();
    const again = record(w.store)!;
    expect(again.registrationId).toBe(enabled.registrationId);
    expect(again.active!.sequence).toBeGreaterThan(enabled.active!.sequence);
    expect(
      typeof w.registrations.delivery(HOST_A, "device-1", {
        registrationId: again.registrationId,
        sequence: again.active!.sequence,
      }),
    ).not.toBe("string");
  });

  it("re-pairs A to B: the old host's version is superseded", async () => {
    const w = await world();
    await w.connectHost(HOST_A);
    w.setSession(HOST_A);
    const app = w.app();
    await app.enable();
    const onA = record(w.store)!;

    await w.connectHost(HOST_B);
    w.setSession(HOST_B);
    await app.enable();
    const onB = record(w.store)!;

    expect(onB.active).toMatchObject({ hostId: HOST_B });
    expect(
      w.registrations.delivery(HOST_A, "device-1", {
        registrationId: onA.registrationId,
        sequence: onA.active!.sequence,
      }),
    ).toBe("superseded");
    expect(
      typeof w.registrations.delivery(HOST_B, "device-1", {
        registrationId: onB.registrationId,
        sequence: onB.active!.sequence,
      }),
    ).not.toBe("string");
  });

  it("clears with the former host offline", async () => {
    const w = await world();
    const host = await w.connectHost(HOST_A);
    w.setSession(HOST_A);
    const app = w.app();
    await app.enable();
    const on = record(w.store)!;

    // The Mac goes away entirely, and the device un-pairs from it.
    host.socket.terminate();
    await new Promise((resolve) => setTimeout(resolve, 60));
    w.setSession(null);

    await app.disable();
    expect(app.status()).toMatchObject({ state: "off", pending: undefined });
    expect(
      w.registrations.delivery(HOST_A, "device-1", {
        registrationId: on.registrationId,
        sequence: on.active!.sequence,
      }),
    ).toBe("not_registered");
  });

  it("resumes a pending intent after a restart, over the same database file", async () => {
    const w = await world();
    const host = await w.connectHost(HOST_A);
    w.setSession(HOST_A);
    host.pushStatus = 503; // the Mac never confirms
    const first = w.app();
    await first.enable();
    expect(first.status()).toMatchObject({ state: "error", pending: "register" });
    const pending = record(w.store)!;
    expect(pending.desired).toMatchObject({ op: "register" });

    // A new PushDelivery over the same keychain: the app process restarted.
    host.pushStatus = 200;
    const second = w.app();
    await second.resume();
    expect(second.status()).toMatchObject({ state: "on", pending: undefined });
    const settled = record(w.store)!;
    expect(settled.registrationId).toBe(pending.registrationId);
    expect(
      typeof w.registrations.delivery(HOST_A, "device-1", {
        registrationId: settled.registrationId,
        sequence: settled.active!.sequence,
      }),
    ).not.toBe("string");

    // And the row is durable on disk, not just in the running process: a second
    // connection to the same file sees the same deliverable version.
    const reader = w.readerOnSameFile();
    try {
      expect(
        typeof reader.delivery(HOST_A, "device-1", {
          registrationId: settled.registrationId,
          sequence: settled.active!.sequence,
        }),
      ).not.toBe("string");
    } finally {
      reader.close();
    }
  });
});

describe("host confirmation lost, then the token rotates", () => {
  it("a lost host confirmation then a rotation recovers on a new version, superseding the spent one", async () => {
    const w = await world();
    const host = await w.connectHost(HOST_A);
    w.setSession(HOST_A);
    host.pushStatus = 503;
    const app = w.app();
    await app.enable();

    const pending = record(w.store)!;
    expect(app.status()).toMatchObject({ state: "error", pending: "register" });
    // The gateway committed, and the app now records that the version is spent.
    // The record now keeps what it prepared to send, written before the request,
    // so the version is known to be spoken for however the attempt ends.
    expect(pending.desired).toMatchObject({
      op: "register",
      prepared: { deviceToken: w.currentToken(), hostId: HOST_A, deviceId: "device-1" },
    });

    w.rotateToken("bb".repeat(32));
    host.pushStatus = 200;
    await app.handleTokenChange();

    const healed = record(w.store)!;
    expect(app.status()).toMatchObject({ state: "on", pending: undefined });
    expect(healed.active!.sequence).toBeGreaterThan(pending.desired!.sequence);
    const live = w.registrations.delivery(HOST_A, "device-1", {
      registrationId: healed.registrationId,
      sequence: healed.active!.sequence,
    });
    expect(typeof live).not.toBe("string");
    if (typeof live !== "string") expect(live.deviceToken).toBe("bb".repeat(32));
    expect(
      w.registrations.delivery(HOST_A, "device-1", {
        registrationId: pending.registrationId,
        sequence: pending.desired!.sequence,
      }),
    ).toBe("superseded");
  });
});

describe("gateway acknowledgement lost, then the token rotates", () => {
  it("a lost acknowledgement still spends the version, so recovery allocates a new one", async () => {
    const w = await world();
    const host = await w.connectHost(HOST_A);
    w.setSession(HOST_A);
    // The gateway handles the registration; its answer never reaches the app.
    w.loseAck("/gateway/v1/push/registrations");
    const first = w.app();
    await first.enable();

    const afterLoss = record(w.store)!;
    const committed = w.registrations.delivery(HOST_A, "device-1", {
      registrationId: afterLoss.registrationId,
      sequence: afterLoss.desired!.sequence,
    });
    const firstToken = w.currentToken();

    // A restart with the same keychain, a token that rotated while the app was
    // not running, and no callback to announce it.
    w.loseAck(null);
    w.rotateToken("cc".repeat(32));
    host.pushStatus = 200;
    const second = w.app();
    await second.resume();

    const after = record(w.store);
    const observed = {
      afterLossDesired: afterLoss.desired,
      afterLossSentToken: afterLoss.sentToken ?? null,
      gatewayCommitted: typeof committed !== "string",
      status: second.status(),
      desired: after?.desired ?? null,
      active: after?.active ?? null,
      gatewayAtOldVersion: w.registrations.delivery(HOST_A, "device-1", {
        registrationId: afterLoss.registrationId,
        sequence: afterLoss.desired!.sequence,
      }),
      gatewayStillHoldsFirstToken:
        typeof committed === "string" ? null : committed.deviceToken === firstToken,
    };
    // eslint-disable-next-line no-console
    console.log("GATEWAY_ACK_LOSS_OUTCOME", JSON.stringify(observed, null, 2));

    // The gateway took the version and the app could not learn that it had —
    // but the attempt was recorded before it was made, so the version is known
    // to be spoken for.
    expect(observed.gatewayCommitted).toBe(true);
    expect(observed.afterLossDesired).toMatchObject({
      op: "register",
      sequence: 1,
      prepared: { deviceToken: "aa".repeat(32), hostId: HOST_A, deviceId: "device-1" },
    });
    // Resume therefore allocates a new version for the rotated token instead of
    // re-spending the old one, and delivery ends up enabled.
    expect(observed.status).toMatchObject({ state: "on", pending: undefined });
    expect(observed.desired).toBeNull();
    expect(observed.active).toMatchObject({ sequence: 2, hostId: HOST_A, deviceId: "device-1" });
    expect(observed.gatewayAtOldVersion).toBe("superseded");
  });
});

describe("same host, fresh device session", () => {
  it("a fresh device session on the same host revokes delivery rather than reporting on", async () => {
    const w = await world();
    const host = await w.connectHost(HOST_A, "device-1");
    host.devicesByBearer.set("device-bearer", "device-1");
    host.devicesByBearer.set("device-2-bearer", "device-2");
    w.setSession(HOST_A);
    const app = w.app();
    await app.enable();
    const on = record(w.store)!;
    expect(app.status()).toMatchObject({ state: "on" });

    // Same Mac, same APNs token, but the device paired again and holds a new
    // device session.
    w.setSessionDevice(HOST_A, "device-2", "device-2-bearer");
    await app.resume();

    const after = record(w.store)!;
    const observed = {
      status: app.status(),
      appActive: after.active,
      appDesired: after.desired ?? null,
      gatewayForDevice1: w.registrations.delivery(HOST_A, "device-1", {
        registrationId: on.registrationId,
        sequence: on.active!.sequence,
      }),
      gatewayForDevice2: w.registrations.delivery(HOST_A, "device-2", {
        registrationId: on.registrationId,
        sequence: on.active!.sequence,
      }),
    };
    // eslint-disable-next-line no-console
    console.log("SAME_HOST_REPAIR_OUTCOME", JSON.stringify(observed, null, 2));

    // The app now records the device it registered for, so a fresh session on
    // the same host is noticed: it revokes at the gateway and says what to do,
    // rather than reporting on against a registration for a dead session.
    expect(observed.status).toMatchObject({ state: "off", pending: undefined });
    expect(observed.status.problem).toMatch(/paired with your Mac again/u);
    expect(observed.appActive).toBeNull();
    expect(observed.appDesired).toBeNull();
    expect(observed.gatewayForDevice1).toBe("not_registered");
    expect(observed.gatewayForDevice2).toBe("not_registered");

    // The prompt is actionable: turning it on again registers for the device
    // that is actually paired now.
    await app.enable();
    const healed = record(w.store)!;
    expect(app.status()).toMatchObject({ state: "on", pending: undefined });
    expect(healed.active).toMatchObject({ hostId: HOST_A, deviceId: "device-2" });
    const forDevice2 = w.registrations.delivery(HOST_A, "device-2", {
      registrationId: healed.registrationId,
      sequence: healed.active!.sequence,
    });
    expect(typeof forDevice2).not.toBe("string");
    expect(
      w.registrations.delivery(HOST_A, "device-1", {
        registrationId: healed.registrationId,
        sequence: healed.active!.sequence,
      }),
    ).toBe("superseded");
  });
});

describe("a real gateway restart", () => {
  it("closes the gateway and its store, then serves the same registration from fresh ones", async () => {
    const root = mkdtempSync(join(tmpdir(), "push-restart-"));
    const dbPath = join(root, "push.sqlite");
    try {
      const before = await startWorld({ dbPath });
      const host = await before.connectHost(HOST_A);
      before.setSession(HOST_A);
      const app = before.app();
      await app.enable();
      const on = record(before.store)!;
      expect(app.status()).toMatchObject({ state: "on" });
      expect(host.seen.some((entry) => entry.path === "/v1/devices/self/push")).toBe(true);

      // Everything the gateway owns goes away: server, sockets and store.
      await before.stop();

      // A genuinely new gateway and a new store over the same file.
      const after = await startWorld({ dbPath });
      try {
        await after.connectHost(HOST_A);
        const survived = after.registrations.delivery(HOST_A, "device-1", {
          registrationId: on.registrationId,
          sequence: on.active!.sequence,
        });
        expect(typeof survived).not.toBe("string");
        if (typeof survived !== "string") {
          expect(survived.deviceToken).toBe("aa".repeat(32));
          expect(survived.hostId).toBe(HOST_A);
        }
      } finally {
        await after.stop();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
