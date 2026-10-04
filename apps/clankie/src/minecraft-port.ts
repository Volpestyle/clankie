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
  join(request: MinecraftJoinRequest): Promise<MinecraftSessionStatus>;
  /** Current connection and its bounded action history; old generations are not returned here. */
  status(): Promise<MinecraftStatus>;
  observe(session: MinecraftSessionRef): Promise<MinecraftObservation>;
  /** Return a handle promptly, independently of long motor work. Replay identical ids, reject conflicting reuse. */
  act(request: MinecraftActionRequest): Promise<MinecraftActionStatus>;
  actionStatus(
    session: MinecraftSessionRef,
    actionId: MinecraftActionId,
  ): Promise<MinecraftActionStatus | null>;
  /** Request motor quiescence; pausing is not yet paused, and the session/lease remain held. */
  pause(session: MinecraftSessionRef): Promise<MinecraftSessionStatus>;
  /** New actions may begin after confirmed pause; never resume an old cancelled handle. */
  resume(session: MinecraftSessionRef): Promise<MinecraftSessionStatus>;
  /** Out-of-band stop request; cancel_requested does not prove the motor stopped or no effect landed. */
  cancel(session: MinecraftSessionRef, actionId: MinecraftActionId): Promise<MinecraftActionStatus>;
  /** Pending/uncertain departure retains ownership. Only confirmed exact disconnect permits release. */
  leave(session: MinecraftSessionRef): Promise<MinecraftSessionStatus>;
}

/** All held operations and callbacks must compare both fields, including after asynchronous setup. */
export function sameMinecraftSession(left: MinecraftSessionRef, right: MinecraftSessionRef): boolean {
  return left.sessionId === right.sessionId && left.connectionGeneration === right.connectionGeneration;
}
