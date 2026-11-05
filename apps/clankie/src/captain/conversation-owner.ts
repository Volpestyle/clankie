import { z } from "zod";

/** Persisted host proof of the route that admitted this work, never tool input. */
export const DiscordWatchOriginSchema = z
  .object({
    baseSessionKey: z.string().min(1),
    targetId: z.string().min(1),
    actorId: z.string().min(1),
    guildId: z.string().min(1).optional(),
    channelId: z.string().min(1),
    messageId: z.string().min(1),
    /** Exact transport receipt identity, independent of the Discord reply message. */
    deliveryId: z.string().min(1).optional(),
    transportKind: z.enum(["bot", "user_session"]),
  })
  .strict();
export type DiscordWatchOrigin = z.infer<typeof DiscordWatchOriginSchema>;

export const ConversationOwnerSchema = z
  .object({
    conversationId: z.string().min(1).max(256),
    discord: DiscordWatchOriginSchema.optional(),
  })
  .strict();
export type ConversationOwner = z.infer<typeof ConversationOwnerSchema>;

/** Host-observed author identity. A pane label alone never identifies a recipient. */
export const NativeSeatRecipientSchema = z
  .object({
    kind: z.literal("native"),
    paneId: z.string().min(1).max(256),
    seatId: z.string().min(1).max(256),
    occupantId: z.string().min(1).max(512),
    binding: z.string().regex(/^[a-f0-9]{64}$/u),
    owner: ConversationOwnerSchema.optional(),
  })
  .strict();
export type NativeSeatRecipient = z.infer<typeof NativeSeatRecipientSchema>;

export const LinearRecipientSchema = z.union([
  NativeSeatRecipientSchema,
  z.object({ kind: z.literal("conversation"), owner: ConversationOwnerSchema }).strict(),
]);
export type LinearRecipient = z.infer<typeof LinearRecipientSchema>;

export interface NativeSeatAuthority {
  readonly recipient: NativeSeatRecipient;
  readonly current: () => boolean;
  readonly authorize: () => Promise<boolean>;
}

/** Attribution only: these proofs grant no connected account or machine tools. */
export interface WorkerWriteAuthority {
  readonly conversationAuthority?: ConversationAuthority;
  readonly nativeRecipientAuthority?: NativeSeatAuthority;
}

export function captureNativeSeatAuthority(source: NativeSeatAuthority): NativeSeatAuthority {
  const recipient = NativeSeatRecipientSchema.parse(source.recipient);
  if (recipient.owner) {
    if (recipient.owner.discord) Object.freeze(recipient.owner.discord);
    Object.freeze(recipient.owner);
  }
  return Object.freeze({
    recipient: Object.freeze(recipient),
    current: source.current,
    authorize: source.authorize,
  });
}

/** A live admitted turn. Persist only owner; refresh authority before each later wake. */
export interface ConversationAuthority {
  /** Service-owned progress observer; grants no authority and sends no brief. */
  readonly onHirePane?: (paneId: string) => void;
  /** Host-verified owner app intent; never copied from model input. */
  readonly ownerHire?: {
    readonly surface: "phone" | "tablet" | "web" | "desktop";
    readonly overrideUsage?: boolean;
  };
  /**
   * Host-verified connector start (ADR 0301): the owner-granted place, not the leading
   * conversation, decides the project. Set only by the service's own start_agent.
   */
  readonly connectorPlace?: {
    readonly projectId: string;
    readonly deviceId?: string;
    readonly channel?: string;
    readonly notify?: import("@clankie/protocol/connector").WorkerNotify;
  };
  readonly owner: ConversationOwner;
  readonly current: () => boolean;
  readonly authorize: () => Promise<boolean>;
}

/** Async preparation plus a retained synchronous authority check for final state changes. */
export type AuthorityGuard = (() => Promise<void>) & { readonly assertCurrent?: () => void };

/** A service-owned automatic operation may have no turn; a supplied turn remains current. */
export function conversationAuthorityGuard(source: ConversationAuthority | undefined): AuthorityGuard {
  const assertCurrent = () => {
    if (source && !source.current()) throw new Error("Conversation authority changed");
  };
  return Object.assign(
    async () => {
      if (source) await assertConversationAuthority(source);
      assertCurrent();
    },
    { assertCurrent },
  );
}

/** Missing conversation binding, distinct from an expired or denied authority. */
export class ConversationRequiredError extends Error {
  constructor(message = "Turn conversation attribution is unavailable") {
    super(message);
    this.name = "ConversationRequiredError";
  }
}

export function captureConversationAuthority(
  source: ConversationAuthority | undefined,
): ConversationAuthority {
  if (source === undefined) throw new ConversationRequiredError();
  const owner = ConversationOwnerSchema.parse(source.owner);
  if (owner.discord !== undefined) Object.freeze(owner.discord);
  return Object.freeze({
    owner: Object.freeze(owner),
    current: source.current,
    authorize: source.authorize,
    ...(source.onHirePane === undefined ? {} : { onHirePane: source.onHirePane }),
    ...(source.ownerHire ? { ownerHire: Object.freeze({ ...source.ownerHire }) } : {}),
    ...(source.connectorPlace
      ? {
          connectorPlace: Object.freeze({
            projectId: source.connectorPlace.projectId,
            ...(source.connectorPlace.channel === undefined
              ? {}
              : { channel: source.connectorPlace.channel }),
            ...(source.connectorPlace.notify === undefined
              ? {}
              : { notify: Object.freeze({ ...source.connectorPlace.notify }) }),
            ...(source.connectorPlace.deviceId === undefined
              ? {}
              : { deviceId: source.connectorPlace.deviceId }),
          }),
        }
      : {}),
  });
}

export async function assertConversationAuthority(source: ConversationAuthority): Promise<void> {
  if (!source.current() || !(await source.authorize()) || !source.current())
    throw new Error("Turn conversation authority is unavailable");
}
