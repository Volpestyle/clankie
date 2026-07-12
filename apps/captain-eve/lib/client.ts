import { ClankieApiClient } from "@clankie/api-client";

export function controlPlaneClient(): ClankieApiClient {
  return new ClankieApiClient({
    baseUrl: process.env.CLANKIE_CONTROL_PLANE_URL ?? "http://127.0.0.1:4310",
    ...(process.env.CLANKIE_CAPTAIN_TOKEN ? { captainToken: process.env.CLANKIE_CAPTAIN_TOKEN } : {}),
  });
}
