import { expect, it } from "vitest";
import { LinearWakeSettingsSchema, linearWakeMatches } from "../src/index.ts";
const owner = { id: "owner", type: "user" };
const match = (rules: unknown, actor = owner, type = "issueNewComment") =>
  linearWakeMatches(LinearWakeSettingsSchema.parse(rules), type, actor, "bot");
it("defaults to owner only, excludes subscriptions and leaves unconfigured or unknown ownership quiet", () => {
  expect(match({})).toBe(false);
  expect(match({ ownerUserIds: ["owner"] })).toBe(true);
  expect(match({ ownerUserIds: ["owner"] }, owner, "issueSubscribed")).toBe(false);
  expect(match({ ownerUserIds: ["owner"] }, { id: "other", type: "user" })).toBe(false);
  expect(match({ ownerUserIds: ["owner"] }, { id: "owner", type: "app" })).toBe(false);
  expect(
    linearWakeMatches(
      LinearWakeSettingsSchema.parse({ actors: ["human", "self", "users"] }),
      "issueMention",
      undefined,
      "bot",
    ),
  ).toBe(false);
});
it("ORs actor selectors, distinguishes humans from self/workers, and matches named IDs", () => {
  expect(match({ actors: ["human"] })).toBe(true);
  expect(match({ actors: ["human"] }, { id: "bot", type: "user" })).toBe(false);
  expect(match({ actors: ["human"] }, { id: "other", type: "unknown" })).toBe(false);
  expect(match({ actors: ["self"] }, { id: "bot", type: "app" })).toBe(true);
  const worker = { id: "different", type: "user", worker: { principalId: "w" } };
  expect(
    linearWakeMatches(LinearWakeSettingsSchema.parse({ actors: ["human"] }), "issueMention", worker, "bot"),
  ).toBe(false);
  expect(
    linearWakeMatches(LinearWakeSettingsSchema.parse({ actors: ["self"] }), "issueMention", worker, "bot"),
  ).toBe(true);
  expect(match({ actors: ["self", "users"], userIds: ["owner"] })).toBe(true);
});
it("limits notification types, exclusions win, and self subscriptions require explicit opt-in", () => {
  expect(match({ actors: ["human"], notificationTypes: ["issueMention"] })).toBe(false);
  expect(match({ actors: ["human"], notificationTypes: ["issueMention"] }, owner, "issueMention")).toBe(true);
  expect(
    match(
      { actors: ["self"], notificationTypes: ["issueSubscribed"] },
      { id: "bot", type: "app" },
      "issueSubscribed",
    ),
  ).toBe(false);
  expect(
    match({ actors: ["self"], excludedNotificationTypes: [] }, { id: "bot", type: "app" }, "issueSubscribed"),
  ).toBe(true);
  expect(match({ actors: [] })).toBe(false);
});
