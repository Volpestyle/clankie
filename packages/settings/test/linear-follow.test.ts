import { expect, it } from "vitest";
import { LinearWebhookSettingsSchema, linearFollowStatus, linearWakeMatches } from "../src/index.ts";

const warning = "following is on, but no owner IDs or emails, so owner comments never wake.";

it("reports a ready but ineffective owner rule without changing following or readiness", () => {
  const settings = LinearWebhookSettingsSchema.parse({
    following: true,
    url: "https://example.com/linear",
    wake: { ownerUserEmails: [] },
  });
  expect(linearFollowStatus(settings, true)).toEqual({
    following: true,
    active: true,
    webhookConfigured: true,
    reason: null,
    missingWebhook: [],
    wakeWarning: warning,
    detail: null,
  });
  expect(linearWakeMatches(settings.wake, "issueNewComment", { id: "james", type: "user" }, "bot")).toBe(
    false,
  );
});

it("keeps webhook readiness separate from the empty owner warning", () => {
  const settings = LinearWebhookSettingsSchema.parse({ following: true, wake: { ownerUserEmails: [] } });
  expect(linearFollowStatus(settings, false)).toMatchObject({
    following: true,
    active: false,
    webhookConfigured: false,
    reason: "linear_webhook_required",
    missingWebhook: ["url", "secret"],
    wakeWarning: warning,
  });
});

it.each([
  { following: false, wake: { actors: ["owner"] } },
  { following: true, wake: { actors: ["owner"], ownerUserIds: ["james"] } },
  { following: true, wake: { actors: ["human"] } },
  { following: true, wake: { actors: [] } },
])("stays quiet when no enabled owner rule is empty: %j", (input) => {
  expect(linearFollowStatus(LinearWebhookSettingsSchema.parse(input), true).wakeWarning).toBeNull();
});

it("names other actor selectors and leaves their wake behavior intact", () => {
  const settings = LinearWebhookSettingsSchema.parse({
    following: true,
    url: "https://example.com/linear",
    wake: { actors: ["owner", "human"], ownerUserEmails: [] },
  });
  expect(linearFollowStatus(settings, true).wakeWarning).toBe(
    `${warning} Other selected actor rules may still wake.`,
  );
  expect(linearWakeMatches(settings.wake, "issueNewComment", { id: "james", type: "user" }, "bot")).toBe(
    true,
  );
});
