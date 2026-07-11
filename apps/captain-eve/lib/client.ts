import { SaplingApiClient } from "@sapling/api-client";

export function controlPlaneClient(): SaplingApiClient {
  return new SaplingApiClient({
    baseUrl: process.env.SAPLING_CONTROL_PLANE_URL ?? "http://127.0.0.1:4310",
    ...(process.env.SAPLING_CAPTAIN_TOKEN ? { captainToken: process.env.SAPLING_CAPTAIN_TOKEN } : {}),
  });
}
