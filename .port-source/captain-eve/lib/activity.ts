import type { ActivityObservationRead } from "@clankie/api-client";

export interface ActivityObservationPort {
  getCurrentActivityObservation(): Promise<ActivityObservationRead>;
}

/**
 * Read Clankie's own current activity through the authenticated projection.
 * The result intentionally preserves the contract's provenance split instead
 * of blending model-authored commentary with runner-observed facts.
 */
export function observeCurrentActivity(client: ActivityObservationPort): Promise<ActivityObservationRead> {
  return client.getCurrentActivityObservation();
}
