import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { BodyConversationIdentity } from "./body-lease-router.ts";
import { ConversationOwnerSchema, type ConversationOwner } from "./captain/conversation-owner.ts";
import type { createDiscordCaptainActionClient } from "./discord-captain-actions.ts";
import { postToDiscordActiveBody } from "./discord-active-body.ts";

const Payload = z
  .strictObject({
    operationId: z.uuid(),
    recipientId: z.string().regex(/^\d{1,32}$/u),
    username: z.string().regex(/^[A-Za-z0-9_]{3,16}$/u),
    providerId: z.string().regex(/^minecraft_friend_[a-z0-9_]+$/u),
  })
  .refine((input) => input.providerId === `minecraft_friend_${input.username.toLowerCase()}`);
const Outcome = z.strictObject({ outcome: z.enum(["delivered", "refused", "uncertain"]) });

export function createMinecraftPrivateDeliveryClient(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
) {
  const pending = new Map<
    string,
    { payload: z.infer<typeof Payload>; expires: number; guard: () => Promise<void> }
  >();
  return {
    async authorize(capability: string, raw: unknown): Promise<boolean> {
      const entry = pending.get(capability);
      const payload = Payload.safeParse(raw);
      if (
        !entry ||
        entry.expires < Date.now() ||
        !payload.success ||
        JSON.stringify(payload.data) !== JSON.stringify(entry.payload)
      )
        return false;
      try {
        await entry.guard();
        return pending.get(capability) === entry && entry.expires >= Date.now();
      } catch {
        return false;
      }
    },
    async deliverCode(
      input: { operationId: string; owner: ConversationOwner; username: string; providerId: string },
      guard: () => Promise<void>,
    ) {
      const owner = ConversationOwnerSchema.parse(input.owner);
      if (!owner.discord) return { outcome: "refused" as const };
      const payload = Payload.parse({
        operationId: input.operationId,
        recipientId: owner.discord.actorId,
        username: input.username,
        providerId: input.providerId,
      });
      const capability = randomBytes(32).toString("hex");
      let dispatched = false;
      try {
        await guard();
        if (pending.size >= 4096) return { outcome: "refused" as const };
        pending.set(capability, { payload, expires: Date.now() + 60_000, guard });
        dispatched = true;
        const response = await postToDiscordActiveBody(
          "/minecraft-login-code",
          { capability, ...payload },
          env,
          fetchImpl,
        );
        if (!response.ok) return { outcome: "uncertain" as const };
        return Outcome.parse(await response.json());
      } catch {
        return { outcome: dispatched ? ("uncertain" as const) : ("refused" as const) };
      } finally {
        pending.delete(capability);
      }
    },
  };
}

const Status = z.object({
  phase: z.literal("running"),
  authReady: z.literal(true),
  version: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/u),
  tunnel: z.object({
    publicAddress: z
      .string()
      .max(260)
      .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?:\d{1,5}$/u)
      .refine((address) => {
        const port = Number(address.split(":").at(-1));
        return port > 0 && port <= 65535;
      }),
  }),
});

/** Only trusted status and immutable requesting-channel identity enter this post. */
export function createMinecraftHostInvite(options: {
  discordActions: ReturnType<typeof createDiscordCaptainActionClient>;
  guard: (identity: BodyConversationIdentity) => Promise<void>;
}) {
  return async (identity: BodyConversationIdentity, raw: unknown) => {
    const status = Status.safeParse(raw);
    const origin = identity.route?.owner.discord;
    if (!status.success || !origin?.guildId || !identity.current()) return { outcome: "refused" as const };
    const captured = Object.freeze({ ...origin });
    const guard = async () => {
      if (!identity.current()) throw new Error("stale_identity");
      await options.guard(identity);
      if (!identity.current()) throw new Error("stale_identity");
    };
    const result = await options.discordActions.execute(
      {
        action: "send_reply",
        callId: randomUUID(),
        actorId: captured.actorId,
        guildId: captured.guildId!,
        channelId: captured.channelId,
        messageId: captured.messageId,
        text: `Minecraft Java ${status.data.version} — connect to \`${status.data.tunnel.publicAddress}\`. Ask me to whitelist your Minecraft name.\nPremium: use your usual launcher; no login setup. Nonpremium: ask me here; I’ll DM a one-time code to enter with /login <code>.`,
      },
      guard,
    );
    return { outcome: result.ok ? ("delivered" as const) : ("uncertain" as const) };
  };
}
