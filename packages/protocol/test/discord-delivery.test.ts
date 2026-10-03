import { expect, it } from "vitest";
import { discordDeliveryStage } from "../src/delivery.ts";

it("distinguishes stored turns, native acceptance, responses, refusals and uncertain failures", () => {
  expect(discordDeliveryStage({ state: "pending" })).toBe("stored");
  expect(discordDeliveryStage({ state: "waiting_user" })).toBe("consumed");
  for (const state of ["settled", "silent", "absorbed"] as const)
    expect(discordDeliveryStage({ state })).toBe("responded");
  expect(discordDeliveryStage({ state: "failed", code: "captain_usage_limit_reached" })).toBe("rejected");
  expect(discordDeliveryStage({ state: "failed", code: "captain_turn_stalled" })).toBe("expired");
  for (const code of [
    "captain_model_failed",
    "captain_session_failed",
    "captain_response_missing",
    "unknown",
  ])
    expect(discordDeliveryStage({ state: "failed", code })).toBe("uncertain");
});
