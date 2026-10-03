import { expect, it } from "vitest";
import {
  fleetDeliveryStage,
  headSeatDeliveryStage,
  harnessDeliveryStage,
  hireDeliveryStage,
  openCodeDeliveryStage,
} from "../src/delivery.ts";
it("distinguishes bridge delivery, native consumption, response and binding readiness", () => {
  expect(headSeatDeliveryStage("delivered")).toBe("delivered");
  expect(headSeatDeliveryStage("replied")).toBe("responded");
  expect(harnessDeliveryStage("accepted")).toBe("consumed");
  expect(fleetDeliveryStage({ outcome: "delivered" })).toBe("delivered");
  for (const state of ["queued", "started", "steered"] as const)
    expect(fleetDeliveryStage({ outcome: "delivered", state })).toBe("consumed");
  expect(openCodeDeliveryStage("ready")).toBeUndefined();
  expect(openCodeDeliveryStage("busy")).toBe("stored");
  expect(openCodeDeliveryStage("delivered")).toBe("consumed");
  expect(hireDeliveryStage({ outcome: "spawned" }, false)).toBeUndefined();
  expect(hireDeliveryStage({ outcome: "spawned" }, true)).toBe("consumed");
});
it("does not collapse uncertainty into unavailability or expiration", () => {
  expect(headSeatDeliveryStage("unconfirmed")).toBe("uncertain");
  expect(harnessDeliveryStage("unconfirmed")).toBe("uncertain");
  expect(fleetDeliveryStage({ outcome: "unconfirmed" })).toBe("uncertain");
  expect(hireDeliveryStage({ outcome: "failed", reason: "delivery_unconfirmed" }, true)).toBe("uncertain");
  expect(headSeatDeliveryStage("unbound")).toBe("unavailable");
  expect(headSeatDeliveryStage("aborted")).toBe("expired");
});
