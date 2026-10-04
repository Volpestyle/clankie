import type {
  MinecraftActionId,
  MinecraftActionRequest,
  MinecraftActionStatus,
  MinecraftJoinRequest,
  MinecraftObservation,
  MinecraftServerProfile,
  MinecraftSessionRef,
  MinecraftSessionStatus,
  MinecraftStatus,
} from "@clankie/protocol";
import { z } from "zod";

export type MinecraftGuard = () => Promise<void>;
export const MinecraftEventsSchema = z
  .strictObject({
    session: z.strictObject({
      sessionId: z.string().min(1).max(128),
      connectionGeneration: z.number().int().positive(),
    }),
    events: z
      .array(
        z.strictObject({
          sequence: z.number().int().positive(),
          at: z.number().int().nonnegative(),
          type: z.enum([
            "chat",
            "damage",
            "death",
            "player_join",
            "player_leave",
            "action_completion",
            "connection",
            "viewer",
          ]),
          data: z.record(z.string().max(128), z.json()),
        }),
      )
      .max(64),
    latestSequence: z.number().int().nonnegative(),
    droppedBeforeSequence: z.number().int().nonnegative(),
  })
  .superRefine((value, context) => {
    let previous = 0;
    for (const [index, event] of value.events.entries()) {
      if (event.sequence <= previous || event.sequence > value.latestSequence)
        context.addIssue({
          code: "custom",
          path: ["events", index, "sequence"],
          message: "Event sequence must increase within the reported latest sequence",
        });
      if (Buffer.byteLength(JSON.stringify(event.data)) > 4096)
        context.addIssue({
          code: "custom",
          path: ["events", index, "data"],
          message: "Minecraft event exceeds 4096 bytes",
        });
      previous = event.sequence;
    }
  });
export type MinecraftEvents = z.infer<typeof MinecraftEventsSchema>;
export const MinecraftViewerStatusSchema = z.strictObject({
  session: z.strictObject({
    sessionId: z.string().min(1).max(128),
    connectionGeneration: z.number().int().positive(),
  }),
  available: z.boolean(),
  frameUrl: z
    .url()
    .refine((url) => {
      const parsed = new URL(url);
      return (
        parsed.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(parsed.hostname) &&
        !parsed.username &&
        !parsed.password
      );
    })
    .optional(),
  width: z.literal(320),
  height: z.literal(180),
  maxBytes: z.literal(262144),
  contentType: z.literal("image/png"),
});
export type MinecraftViewerStatus = z.infer<typeof MinecraftViewerStatusSchema>;

/**
 * Minecraft's external-body seam, implemented by the service-owned MCP adapter.
 * The service owns profile policy, authority and the play lease; the adapter
 * owns motor settlement and fresh world observations. No account material or
 * arbitrary destination crosses this model-facing seam.
 * Schemas check shape/time/expected-versus-observed consistency; the producer
 * must authenticate provenance and derive postconditions from the exact action.
 */
export interface MinecraftPort {
  profiles(): Promise<readonly MinecraftServerProfile[]>;
  /** Start promptly with the host's persisted identity, before any bot effect. */
  join(request: MinecraftJoinRequest, guard?: MinecraftGuard): Promise<MinecraftSessionStatus>;
  /** Current connection and its bounded action history; old generations are not returned here. */
  status(): Promise<MinecraftStatus>;
  observe(session: MinecraftSessionRef, guard?: MinecraftGuard): Promise<MinecraftObservation>;
  /** Return a handle promptly, independently of long motor work. Replay identical ids, reject conflicting reuse. */
  act(request: MinecraftActionRequest, guard?: MinecraftGuard): Promise<MinecraftActionStatus>;
  actionStatus(
    session: MinecraftSessionRef,
    actionId: MinecraftActionId,
    guard?: MinecraftGuard,
  ): Promise<MinecraftActionStatus | null>;
  /** Request motor quiescence; pausing is not yet paused, and the session/lease remain held. */
  pause(session: MinecraftSessionRef, guard?: MinecraftGuard): Promise<MinecraftSessionStatus>;
  /** New actions may begin after confirmed pause; never resume an old cancelled handle. */
  resume(session: MinecraftSessionRef, guard?: MinecraftGuard): Promise<MinecraftSessionStatus>;
  /** Out-of-band stop request; cancel_requested does not prove the motor stopped or no effect landed. */
  cancel(
    session: MinecraftSessionRef,
    actionId: MinecraftActionId,
    guard?: MinecraftGuard,
  ): Promise<MinecraftActionStatus>;
  /** Pending/uncertain departure retains ownership. Only confirmed exact disconnect permits release. */
  leave(session: MinecraftSessionRef, guard?: MinecraftGuard): Promise<MinecraftSessionStatus>;
  pollEvents?(
    session: MinecraftSessionRef,
    afterSequence: number,
    guard?: MinecraftGuard,
  ): Promise<MinecraftEvents>;
  viewerStatus?(session: MinecraftSessionRef): Promise<MinecraftViewerStatus>;
  /** Fresh owner profile policy for ongoing stays; stopping remains possible after revocation. */
  approved?(session: MinecraftSessionRef): Promise<boolean>;
}

/** All held operations and callbacks must compare both fields, including after asynchronous setup. */
export function sameMinecraftSession(left: MinecraftSessionRef, right: MinecraftSessionRef): boolean {
  return left.sessionId === right.sessionId && left.connectionGeneration === right.connectionGeneration;
}
