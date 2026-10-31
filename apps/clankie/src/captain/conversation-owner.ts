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
  /** Host-verified owner app intent; never copied from model input. */
  readonly ownerHire?: {
    readonly surface: "phone" | "tablet" | "web" | "desktop";
    readonly overrideUsage?: boolean;
  };
  /**
   * Host-verified connector start (ADR 0301): the owner-granted place, not the leading
   * conversation, decides the project. Set only by the service's own start_agent.
   */
  readonly connectorPlace?: { readonly projectId: string };
  readonly owner: ConversationOwner;
  readonly current: () => boolean;
  readonly authorize: () => Promise<boolean>;
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
    ...(source.ownerHire ? { ownerHire: Object.freeze({ ...source.ownerHire }) } : {}),
    ...(source.connectorPlace
      ? { connectorPlace: Object.freeze({ projectId: source.connectorPlace.projectId }) }
      : {}),
  });
}

export async function assertConversationAuthority(source: ConversationAuthority): Promise<void> {
  if (!source.current() || !(await source.authorize()) || !source.current())
    throw new Error("Turn conversation authority is unavailable");
}
