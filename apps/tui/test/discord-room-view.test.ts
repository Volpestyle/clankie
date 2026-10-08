import { expect, it } from "vitest";
import { DiscordSettingsSchema, type DiscordRoomStatus } from "@clankie/protocol";
import { DISCORD_EDITABLE_FIELDS } from "../src/discord-commands.ts";
import { formatDiscordRoomStatus } from "../src/discord-room-view.ts";
it("the TUI field editor exposes canonical settings without retired machine grants", () => {
  const retired = new Set(["systemActorGuildIds", "systemActorChannelIds"]);
  expect(new Set(DISCORD_EDITABLE_FIELDS).size).toBe(DISCORD_EDITABLE_FIELDS.length);
  expect(new Set(DISCORD_EDITABLE_FIELDS)).toEqual(
    new Set(Object.keys(DiscordSettingsSchema.shape).filter((field) => !retired.has(field))),
  );
});
it("shows explicit silence/failure and private guidance without claiming pending deliveries were answered", () => {
  const room: DiscordRoomStatus = {
    conversationId: "room-garden",
    title: "Garden",
    coverage: "observed",
    since: "2026-10-03T00:00:00.000Z",
    received: 5,
    answered: 1,
    silent: 1,
    failed: 1,
    missed: 1,
    pending: 1,
    absorbedUnknown: 0,
    lastReason: "backlog_capacity_evicted",
    guidance: { revision: 1, state: "pending", text: "Consider the earlier question" },
  };
  const view = formatDiscordRoomStatus(room);
  expect(view).toContain("Garden");
  expect(view).toContain("answered 1");
  expect(view).toContain("Pending 1");
  expect(view).toContain("Private guidance: pending");
  expect(view).toContain("backlog_capacity_evicted");
});
