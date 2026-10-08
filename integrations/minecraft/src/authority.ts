import type { BodyLeaseView, BodyResource } from "@clankie/protocol";

/** Attribution supplied by core. These fields never grant authority. */
export interface MinecraftOwnerRoute {
  owner: {
    conversationId: string;
    discord?:
      | {
          baseSessionKey: string;
          targetId: string;
          actorId: string;
          guildId?: string | undefined;
          channelId: string;
          messageId: string;
          deliveryId?: string | undefined;
          transportKind: "bot" | "user_session";
        }
      | undefined;
  };
  mode: "machine" | "social";
}

/** Captured authenticated host binding, never parsed from game/tool arguments. */
export interface MinecraftIdentity {
  readonly conversationId: string;
  readonly route?: MinecraftOwnerRoute;
  readonly current: () => boolean;
  readonly authorize: (resource: BodyResource, action: "effect" | "recover") => Promise<boolean>;
}

export interface MinecraftLeaseReference {
  resource: BodyResource;
  conversationId: string;
  token: string;
}
type Refusal = {
  outcome: "rejected";
  reason: "stale_lease" | "recovery_required" | "store_unavailable";
};

/** The core's durable ledger implements this port. No extension-owned ledger. */
export interface MinecraftLeaseAuthority {
  acquire(
    resource: "play",
    conversationId: string,
    ttlMs: number,
    route?: MinecraftOwnerRoute,
  ):
    | { outcome: "acquired"; lease: MinecraftLeaseReference; expiresAt: number }
    | { outcome: "busy"; lease: BodyLeaseView }
    | Refusal;
  begin(ref: MinecraftLeaseReference): { outcome: "admitted"; operationId: string } | Refusal;
  finish(
    ref: MinecraftLeaseReference,
    operationId: string,
    outcome: "settled" | "uncertain",
  ): { outcome: "finished" } | Refusal;
  validate(ref: MinecraftLeaseReference, operationId: string): { outcome: "valid" } | Refusal;
  renew(ref: MinecraftLeaseReference, ttlMs: number): { outcome: "renewed"; expiresAt: number } | Refusal;
  recoveryReference(resource: "play"): MinecraftLeaseReference | undefined;
  status(resource: "play"): BodyLeaseView | undefined;
  reconcileStopped(ref: MinecraftLeaseReference): { outcome: "released" } | Refusal;
}
