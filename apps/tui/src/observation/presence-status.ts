import { z } from "zod";

/** Read-only operator projection of the published presence phase. */
export const PRESENCE_STATUS_PATH = "/v1/discord/presence-status";

export const PresenceStatusSchema = z.object({
  schemaVersion: z.literal(1),
  sessions: z.array(
    z.object({
      phase: z.string().min(1),
      gatewayConnected: z.boolean(),
      voiceGuildCount: z.number().int().nonnegative(),
      activityCount: z.number().int().nonnegative(),
    }),
  ),
});
export type PresenceStatus = z.infer<typeof PresenceStatusSchema>;
export type PresenceStatusSession = PresenceStatus["sessions"][number];

/** Phases that count as a live, acting presence. */
const LIVE_PRESENCE_PHASES: ReadonlySet<string> = new Set(["present", "voice_active", "go_live_active"]);

export function pickPresenceSession(status: PresenceStatus): PresenceStatusSession | undefined {
  const live = status.sessions.filter((session) => LIVE_PRESENCE_PHASES.has(session.phase));
  return live[0] ?? status.sessions[0];
}
