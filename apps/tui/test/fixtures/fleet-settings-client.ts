import { mintOperatorToken } from "@clankie/credential-broker";
import type { SettingsStore } from "@clankie/settings";
import { createFleetSettingsRoutes } from "../../../clankie/src/fleet-settings-routes.ts";

/** Real owner route and settings boundary, without a production service. */
export function fleetSettingsClient(settings: SettingsStore) {
  const token = mintOperatorToken();
  const routes = createFleetSettingsRoutes(
    async (request) =>
      request.headers.get("authorization") === `Bearer ${token}` ? true : "authentication_required",
    settings,
  );
  return {
    settings,
    env: { CLANKIE_OPERATOR_TOKEN: token },
    host: "http://clankie.test",
    fetchImpl: ((url: RequestInfo | URL, init?: RequestInit) =>
      routes.fetch(new Request(String(url), init))) as typeof fetch,
  };
}
