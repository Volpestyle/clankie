import type { LinearWebhookSettings } from "./schema.ts";

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
