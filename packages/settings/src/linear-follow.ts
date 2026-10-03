import type { LinearWebhookSettings, LinearWakeSettings } from "./schema.ts";

/** Local configuration readiness, not proof that Linear is delivering webhooks. */
export function linearFollowStatus(settings: LinearWebhookSettings, secretPresent: boolean) {
  const missingWebhook: ("url" | "secret")[] = [];
  if (!settings.url) missingWebhook.push("url");
  if (!secretPresent) missingWebhook.push("secret");
  const webhookConfigured = missingWebhook.length === 0;
  return {
    following: settings.following,
    active: settings.following && webhookConfigured,
    webhookConfigured,
    reason: webhookConfigured ? null : ("linear_webhook_required" as const),
    missingWebhook,
    detail: webhookConfigured
      ? null
      : `Following requires a configured Linear webhook (missing: ${missingWebhook.join(", ")}). Use /connect linear → Follow Linear → Configure webhook.`,
  };
}

/** Unknown authors never wake. Own-account/worker provenance takes precedence over human. */
export function linearWakeMatches(
  rules: LinearWakeSettings,
  notificationType: string,
  actor: { id: string; type?: string | undefined; worker?: unknown } | undefined,
  ownUserId: string,
): boolean {
  if (!actor || rules.excludedNotificationTypes.includes(notificationType)) return false;
  if (rules.notificationTypes.length && !rules.notificationTypes.includes(notificationType)) return false;
  const self = actor.id === ownUserId || actor.worker !== undefined;
  const human = !self && actor.type === "user";
  return rules.actors.some((selector) =>
    selector === "self"
      ? self
      : selector === "human"
        ? human
        : selector === "owner"
          ? human && rules.ownerUserIds.includes(actor.id)
          : rules.userIds.includes(actor.id),
  );
}
