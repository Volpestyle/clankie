import { createECDH, type ECDH, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CredentialStore } from "@clankie/credential-broker";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  DISCORD_INGRESS_PATH,
  DiscordIngressResultSchema,
  discordEventDigest,
  type DiscordIngressEvent,
  type DiscordIngressResult,
} from "@clankie/protocol/discord-ingress";
import { openDiscordIngress } from "@clankie/protocol/discord-ingress-crypto";
import type { CaptainPort } from "./captain/port.ts";
import type { HostedBodyClient } from "./hosted-body.ts";

const SavedSchema = z
  .array(
    z
      .object({
        id: z.string(),
        digest: z.string(),
        expiresAtMs: z.number(),
        result: DiscordIngressResultSchema,
      })
      .strict(),
  )
  .max(2000);
type Saved = z.infer<typeof SavedSchema>[number];
/** Durable admission precedes a captain turn. An uncertain restart never repeats machine effects. */
export class DiscordIngress {
  private readonly deliveries = new Map<string, Saved>();
  private readonly options: {
    tenantId: string;
    installationId: string;
    key: ECDH;
    verifyKeys: ReadonlyMap<string, KeyObject>;
    statePath: string;
    clock?: () => number;
    execute: (event: DiscordIngressEvent) => Promise<DiscordIngressResult>;
    onWork?: () => void;
  };
  constructor(options: DiscordIngress["options"]) {
    this.options = options;
    try {
      for (const saved of SavedSchema.parse(JSON.parse(readFileSync(options.statePath, "utf8")))) {
        if (saved.result.state === "pending") saved.result = { state: "failed", code: "interrupted" };
        this.deliveries.set(saved.id, saved);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("discord_inbox_invalid");
    }
  }
  private persist(): void {
    mkdirSync(dirname(this.options.statePath), { recursive: true, mode: 0o700 });
    const temp = `${this.options.statePath}.tmp`;
    writeFileSync(temp, JSON.stringify([...this.deliveries.values()]), { mode: 0o600 });
    renameSync(temp, this.options.statePath);
  }
  accept(input: unknown): Response {
    const nowMs = this.options.clock?.() ?? Date.now();
    let opened: ReturnType<typeof openDiscordIngress>;
    try {
      opened = openDiscordIngress(input, { ...this.options, nowMs });
    } catch {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    try {
      const event = opened.event,
        digest = discordEventDigest(event);
      for (const [id, saved] of this.deliveries) if (saved.expiresAtMs <= nowMs) this.deliveries.delete(id);
      let saved = this.deliveries.get(event.deliveryId);
      if (saved && saved.digest !== digest)
        return Response.json({ error: "delivery_conflict" }, { status: 409 });
      if (!saved) {
        if (this.deliveries.size >= 2000) return Response.json({ error: "capacity" }, { status: 429 });
        saved = {
          id: event.deliveryId,
          digest,
          expiresAtMs: event.expiresAtMs + 300_000,
          result: { state: "pending" },
        };
        this.deliveries.set(saved.id, saved);
        try {
          this.persist();
        } catch {
          this.deliveries.delete(saved.id);
          return Response.json({ error: "unavailable" }, { status: 503 });
        }
        this.options.onWork?.();
        const record = saved;
        void Promise.resolve()
          .then(() => this.options.execute(event))
          .then((result) => {
            record.result = DiscordIngressResultSchema.parse(result);
          })
          .catch(() => {
            record.result = { state: "failed", code: "unavailable" };
          })
          .finally(() => {
            try {
              this.persist();
            } catch {
              record.result = { state: "failed", code: "unavailable" };
            }
          });
      }
      return Response.json(
        { sealed: opened.sealResponse(saved.result) },
        { headers: { "cache-control": "no-store" } },
      );
    } finally {
      opened.destroy();
    }
  }
}
export function createDiscordIngressRoutes(ingress: DiscordIngress | undefined): Hono {
  const app = new Hono();
  app.use(
    DISCORD_INGRESS_PATH,
    bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.json({ error: "malformed" }, 413) }),
  );
  app.post(DISCORD_INGRESS_PATH, async (c) => {
    if (!ingress) return c.json({ error: "not_found" }, 404);
    return ingress.accept(await c.req.json().catch(() => undefined));
  });
  return app;
}
export async function createHostedDiscordIngress(options: {
  client: HostedBodyClient;
  store: CredentialStore;
  statePath: string;
  captain: CaptainPort;
  onWork?: () => void;
}): Promise<{ ingress: DiscordIngress; close(): void }> {
  const provider = `clankie-discord-ingress-${options.client.hostId}`;
  const existing = await options.store.get(provider),
    key = createECDH("prime256v1");
  if (existing) {
    if (existing.type !== "api") throw new Error("discord_key_invalid");
    key.setPrivateKey(Buffer.from(existing.key, "hex"));
  } else {
    key.generateKeys();
    await options.store.set(provider, { type: "api", key: key.getPrivateKey().toString("hex") });
  }
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const register = async () => {
    try {
      const response = await options.client.post("discord-key", {
        publicKey: key.getPublicKey().toString("base64url"),
      });
      if (!response.ok) throw new Error("unavailable");
    } catch {
      if (!stopped) {
        timer = setTimeout(() => void register(), 30_000);
        timer.unref();
      }
    }
  };
  void register();
  return {
    ingress: new DiscordIngress({
      tenantId: options.client.bootstrap.tenantId,
      installationId: options.client.bootstrap.installationId,
      verifyKeys: options.client.keys,
      key,
      statePath: options.statePath,
      ...(options.onWork === undefined ? {} : { onWork: options.onWork }),
      execute: async (event) => {
        const result = await options.captain.submitDiscordTurn(
          {
            schemaVersion: 1,
            deliveryId: event.deliveryId,
            identity: {
              presenceSessionId: `discord:${event.channelId}`,
              correlationId: event.deliveryId,
              profileHash: "hosted-discord-v1",
              characterId: "clankie",
              credentialRef: "hosted_discord",
              transportKind: "bot",
            },
            trigger: {
              kind:
                event.kind === "slash" ? "slash_handoff" : event.kind === "reply" ? "mention" : event.kind,
              id: event.messageId,
              ...(event.guildId === undefined ? {} : { guildId: event.guildId }),
              channelId: event.channelId,
              messageId: event.messageId,
              actorId: event.actorId,
              ...(event.content.length === 0 ? {} : { body: event.content }),
              attachments: event.attachments,
            },
            contextMessages: [],
          },
          { verifiedOwner: event.owner },
        );
        if (result.state === "settled") return { state: "reply", text: result.response };
        if (result.state === "waiting_user") return { state: "reply", text: result.prompt };
        if (result.state === "failed") return { state: "failed", code: "unavailable" };
        return { state: "silent" };
      },
    }),
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
