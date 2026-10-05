import type { LinearWebhookSettings, LinearWakeSettings } from "./schema.ts";

/** Local configuration readiness, not proof that Linear is delivering webhooks. */
export function linearFollowStatus(settings: LinearWebhookSettings, secretPresent: boolean) {
  const missingWebhook: ("url" | "secret")[] = [];
  if (!settings.url) missingWebhook.push("url");
  if (!secretPresent) missingWebhook.push("secret");
  const webhookConfigured = missingWebhook.length === 0;
  const missingOwnerIds =
    settings.following &&
    settings.wake.actors.includes("owner") &&
    settings.wake.ownerUserIds.length === 0 &&
    settings.wake.ownerUserEmails.length === 0;
  const wakeWarning = missingOwnerIds
    ? `following is on, but no owner IDs or emails, so owner comments never wake.${settings.wake.actors.some((actor) => actor !== "owner") ? " Other selected actor rules may still wake." : ""}`
    : null;
  return {
    following: settings.following,
    active: settings.following && webhookConfigured,
    webhookConfigured,
    reason: webhookConfigured ? null : ("linear_webhook_required" as const),
    missingWebhook,
    wakeWarning,
    detail: webhookConfigured
      ? null
      : `Following requires a configured Linear webhook (missing: ${missingWebhook.join(", ")}). Use /connect linear → Follow Linear → Configure webhook.`,
  };
}

/** Unknown authors never wake. Own-account/worker provenance takes precedence over human. */
export function linearWakeMatches(
  rules: LinearWakeSettings,
  notificationType: string,
  actor: { id: string; type?: string | undefined; email?: string | undefined; worker?: unknown } | undefined,
  ownUserId: string,
): boolean {
  if (!actor || rules.excludedNotificationTypes.includes(notificationType)) return false;
  if (rules.notificationTypes.length && !rules.notificationTypes.includes(notificationType)) return false;
  const self = actor.id === ownUserId || actor.worker !== undefined;
  const human = !self && actor.type === "user";
  const owner =
    !self &&
    (actor.type === undefined || actor.type === "user") &&
    (rules.ownerUserIds.includes(actor.id) ||
      (actor.email !== undefined &&
        rules.ownerUserEmails.some((email) => email.toLowerCase() === actor.email!.toLowerCase())));
  return rules.actors.some((selector) =>
    selector === "self"
      ? self
      : selector === "human"
        ? human
        : selector === "owner"
          ? owner
          : rules.userIds.includes(actor.id),
  );
}
