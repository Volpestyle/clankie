import type { FleetLeadTouch } from "@clankie/protocol/fleet-leads";

export interface LeadActivityObservation {
  deviceId?: string;
  channel?: string | undefined;
  at: string;
  touch?: FleetLeadTouch;
}
export interface LeadActivity {
  deviceId?: string;
  channel?: string;
  lastActiveAt: string;
  touches: FleetLeadTouch[];
}
export interface LeadHire {
  seatId: string;
  occupantId: string;
  startedBy: { kind: "clankie" } | { kind: "app"; deviceId: string; channel?: string };
}

/** Display facts only. Channel labels never enter native delivery or admission. */
export class FleetLeadActivity {
  private readonly leads = new Map<string, LeadActivity>();
  record(input: LeadActivityObservation): void {
    const key = JSON.stringify([input.deviceId ?? null, input.channel ?? null]);
    const prior = this.leads.get(key);
    this.leads.set(key, {
      ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
      ...(input.channel === undefined ? {} : { channel: input.channel }),
      lastActiveAt: input.at,
      touches: [...(input.touch === undefined ? [] : [input.touch]), ...(prior?.touches ?? [])]
        .filter((touch) => Date.parse(input.at) - Date.parse(touch.at) < 30 * 60_000)
        .slice(0, 20),
    });
    this.recent(Date.parse(input.at));
  }
  recent(now = Date.now()): LeadActivity[] {
    for (const [key, lead] of this.leads) {
      if (now - Date.parse(lead.lastActiveAt) >= 24 * 60 * 60_000) this.leads.delete(key);
      else lead.touches = lead.touches.filter((touch) => now - Date.parse(touch.at) < 30 * 60_000);
    }
    return [...this.leads.values()].map((lead) => ({ ...lead, touches: [...lead.touches] }));
  }
}
