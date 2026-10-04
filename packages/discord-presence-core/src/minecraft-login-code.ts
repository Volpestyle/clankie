import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

const RequestSchema = z
  .strictObject({
    capability: z.string().regex(/^[a-f0-9]{64}$/u),
    operationId: z.uuid(),
    recipientId: z.string().regex(/^\d{1,32}$/u),
    username: z.string().regex(/^[A-Za-z0-9_]{3,16}$/u),
    providerId: z.string().regex(/^clankie_minecraft_friend_[a-z0-9_]+$/u),
  })
  .refine((input) => input.providerId === `clankie_minecraft_friend_${input.username.toLowerCase()}`);

/** Host-only secret relay. No secret is returned or retained in a generic delivery receipt. */
export function createMinecraftLoginCodeDelivery(options: {
  apiUrl: string;
  bridgeToken: string;
  discordToken: string;
  transport: "bot" | "user_session";
  getCredential(providerId: string): Promise<{ type: string; key?: string } | undefined>;
  fetch?: typeof fetch;
}) {
  const request = options.fetch ?? fetch;
  const settled = new Map<string, number>();
  return async (raw: unknown): Promise<{ outcome: "delivered" | "refused" | "uncertain" }> => {
    const parsed = RequestSchema.safeParse(raw);
    if (!parsed.success) return { outcome: "refused" };
    const input = parsed.data;
    for (const [id, expires] of settled) if (expires < Date.now()) settled.delete(id);
    if (settled.size >= 4096 || settled.has(input.operationId)) return { outcome: "refused" };
    let sent = false;
    const authorize = async () => {
      const result = await request(new URL("/v1/internal/minecraft-login-code/authorize", options.apiUrl), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.bridgeToken}` },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(5_000),
      });
      if (!result.ok) throw new Error("refused");
    };
    try {
      await authorize();
      settled.set(input.operationId, Date.now() + 120_000);
      const credential = await options.getCredential(input.providerId);
      if (credential?.type !== "api" || !credential.key || !/^[A-Za-z0-9_-]{16,128}$/u.test(credential.key))
        return { outcome: "refused" };
      const headers = {
        "content-type": "application/json",
        authorization: options.transport === "bot" ? `Bot ${options.discordToken}` : options.discordToken,
      };
      await authorize();
      const dm = await request("https://discord.com/api/v10/users/@me/channels", {
        method: "POST",
        headers,
        body: JSON.stringify({ recipient_id: input.recipientId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!dm.ok) return { outcome: "refused" };
      const channel = z.object({ id: z.string().regex(/^\d{1,32}$/u) }).parse(await dm.json());
      await authorize();
      sent = true;
      const result = await request(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          content: `Your Minecraft login for ${input.username}: /login ${credential.key}\nUse this code once; request a fresh code from me if it expires.`,
          allowed_mentions: { parse: [] },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      return { outcome: result.ok ? "delivered" : result.status >= 500 ? "uncertain" : "refused" };
    } catch {
      return { outcome: sent ? "uncertain" : "refused" };
    }
  };
}

export function tryHandleMinecraftLoginCodeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deliver: (raw: unknown) => Promise<{ outcome: "delivered" | "refused" | "uncertain" }>,
): boolean {
  if (request.method !== "POST" || (request.url ?? "").split("?")[0] !== "/minecraft-login-code")
    return false;
  const chunks: Buffer[] = [];
  let size = 0;
  request.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size <= 4096) chunks.push(chunk);
  });
  request.on("end", () => {
    void (async () => {
      let outcome: { outcome: "delivered" | "refused" | "uncertain" } = { outcome: "refused" };
      try {
        if (size <= 4096) outcome = await deliver(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        /* Safe refusal only. */
      }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(outcome));
    })();
  });
  return true;
}
