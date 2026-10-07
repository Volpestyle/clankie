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
import { HostedDiscordOperator } from "./hosted-discord.ts";

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
/** Anything that opens and answers one sealed ingress envelope. */
export interface DiscordIngressPort {
  accept(input: unknown): Response;
}
export function createDiscordIngressRoutes(ingress: DiscordIngressPort | undefined): Hono {
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
/** Compose the existing local voice routes; the connection never receives their bearer. */
export function createHostedDiscordVoiceCallback(
  fetchVoice: (request: Request) => Response | Promise<Response>,
  bridgeBearer: string,
): (event: DiscordIngressEvent) => Promise<DiscordIngressResult> {
  return async (event) => {
    const operation = event.voice;
    if (!operation || operation.action === "handoff") return { state: "failed", code: "unavailable" };
    const briefing = operation.action === "briefing";
    const response = await fetchVoice(
      new Request(`http://localhost/v1/discord/${briefing ? "voice-briefing" : "voice-self-tool"}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bridgeBearer}` },
        body: JSON.stringify({
          schemaVersion: 1,
          guildId: event.guildId,
          channelId: event.channelId,
          ...(briefing
            ? { consentedUserIds: operation.consentedUserIds }
            : {
                speakerId: event.actorId,
                tool: operation.tool,
                arguments: operation.arguments,
              }),
        }),
      }),
    );
    if (!response.ok) return { state: "failed", code: "unavailable" };
    const result = await response.json();
    return {
      state: "voice",
      result: briefing
        ? { instructions: result.instructions, briefing: result.briefing }
        : { text: result.text, isError: result.isError },
    };
  };
}
/**
 * Turn an opened ingress event into the existing Discord captain flow. Shared by
 * hosted bodies and the free official-bot route on a self-hosted machine; only
 * who counts as the verified owner differs.
 */
export function discordIngressExecutor(options: {
  captain: CaptainPort;
  voice?: (event: DiscordIngressEvent) => Promise<DiscordIngressResult>;
  verifiedOwner: (event: DiscordIngressEvent) => boolean;
  current: () => boolean;
}): (event: DiscordIngressEvent) => Promise<DiscordIngressResult> {
  return async (event) => {
    if (event.kind === "voice") {
      if (event.voice?.action !== "handoff")
        return options.voice?.(event) ?? { state: "failed", code: "unavailable" };
      const request = event.voice.request;
      const result = await options.captain.submitDiscordTurn(
        {
          ...request,
          deliveryId: event.deliveryId,
          identity: {
            ...request.identity,
            presenceSessionId: `discord:${event.channelId}`,
            correlationId: event.deliveryId,
            profileHash: "hosted-discord-v1",
            characterId: "clankie",
            credentialRef: "hosted_discord",
            transportKind: "bot",
          },
        },
        { verifiedOwner: options.verifiedOwner(event), sourceCurrent: options.current },
      );
      return {
        state: "voice",
        result:
          result.state === "waiting_user" && result.approvalRequired
            ? {
                ...result,
                prompt: "I need you to continue that request on the authenticated operator surface.",
              }
            : result,
      };
    }
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
          kind: event.kind === "slash" ? "slash_handoff" : event.kind === "reply" ? "mention" : event.kind,
          id: event.messageId,
          ...(event.guildId === undefined ? {} : { guildId: event.guildId }),
          channelId: event.channelId,
          messageId: event.messageId,
          actorId: event.actorId,
          ...(event.content.length === 0 ? {} : { body: event.content }),
          attachments: event.attachments,
        },
        contextMessages: (event.context ?? []).map((message) => ({
          id: message.messageId,
          authorId: message.actorId,
          body: message.content,
          createdAt: new Date(message.atMs).toISOString(),
        })),
      },
      // This callback is host proof from the authenticated encrypted ingress,
      // never a JSON claim or a substitute for later room grant checks.
      { verifiedOwner: options.verifiedOwner(event), sourceCurrent: options.current },
    );
    if (result.state === "settled") return { state: "reply", text: result.response };
    if (result.state === "waiting_user")
      return {
        state: "reply",
        text: result.approvalRequired
          ? "I need you to continue that request on the authenticated operator surface."
          : result.prompt,
      };
    if (result.state === "failed") return { state: "failed", code: "unavailable" };
    return { state: "silent" };
  };
}
export async function createHostedDiscordIngress(options: {
  client: HostedBodyClient;
  store: CredentialStore;
  statePath: string;
  captain: CaptainPort;
  onWork?: () => void;
  /** Existing service voice routes, composed locally; no extra HTTP authority. */
  voice?: (event: DiscordIngressEvent) => Promise<DiscordIngressResult>;
}): Promise<{ ingress: DiscordIngress; operator: HostedDiscordOperator; close(): void }> {
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
    operator: new HostedDiscordOperator({
      tenantId: options.client.bootstrap.tenantId,
      installationId: options.client.bootstrap.installationId,
      accountId: options.client.bootstrap.accountId,
      key,
      verifyKeys: options.client.keys,
      statePath: `${options.statePath}.web-admissions`,
      authorize: (permit) => options.client.authorizeDiscordWeb(permit),
    }),
    ingress: new DiscordIngress({
      tenantId: options.client.bootstrap.tenantId,
      installationId: options.client.bootstrap.installationId,
      verifyKeys: options.client.keys,
      key,
      statePath: options.statePath,
      ...(options.onWork === undefined ? {} : { onWork: options.onWork }),
      execute: discordIngressExecutor({
        captain: options.captain,
        ...(options.voice === undefined ? {} : { voice: options.voice }),
        // The hosted edge asserts the linked owner from the authenticated connection.
        verifiedOwner: (event) => event.owner,
        current: () => !stopped,
      }),
    }),
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
