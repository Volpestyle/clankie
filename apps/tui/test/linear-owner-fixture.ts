import { afterEach } from "vitest";
import { createClankieApp } from "../../clankie/src/app.ts";
import type { SettingsStore } from "@clankie/settings";
import type { CredentialStore } from "@clankie/credential-broker";
import { LINEAR_WEBHOOK_PROVIDER_ID } from "@clankie/credential-broker";
import { createStubCaptain } from "../../clankie/src/captain/port.ts";

/** Real route/schema/store boundary, with service-owned webhook credentials. */
const closes: Array<() => void> = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
});
export async function linearOwnerFixture(settings: SettingsStore, credentials: Pick<CredentialStore, "get">) {
  const service = await createClankieApp({
    settings,
    captain: createStubCaptain(),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "fixture-owner" } : undefined,
    linearWebhook: {
      secret: async () => {
        const stored = await credentials.get(LINEAR_WEBHOOK_PROVIDER_ID);
        return stored?.type === "api" ? stored.key : undefined;
      },
    },
  });
  closes.push(service.close);
  return {
    settings,
    credentials,
    env: { CLANKIE_OPERATOR_TOKEN: "owner" },
    host: "http://linear-owner.test",
    fetchImpl: (async (input, init) =>
      service.app.request(input instanceof Request ? input : String(input), init)) as typeof fetch,
  };
}
